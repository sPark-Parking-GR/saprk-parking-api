import { Injectable, Logger } from '@nestjs/common'
import { LifecycleStatus, Prisma, SubscriptionStatus } from '@prisma/client'
import type {
  SubscriptionBillingStatus,
  SubscriptionBillingWebhookEvent,
} from '@spark/subscription-billing'
import { isWebhookReplayTarget, type WebhookSurface } from '../common/webhook-surface'
import { PrismaService } from '../prisma/prisma.service'
import { SubscriptionBillingService } from '../subscription-billing/subscription-billing.service'
import { LIVE_SUBSCRIPTION_STATUSES } from './subscriptions.constants'

export type OperatorSubscriptionEventOutcome =
  | 'processed'
  | 'duplicate'
  | 'not_an_operator'
  | 'unmatched_plan'
  | 'unmatched_subscription'
  | 'already_applied'
  | 'stale'

interface HandlerResult {
  outcome: Exclude<OperatorSubscriptionEventOutcome, 'duplicate'>
  /** What the audit row is filed against; the event's own id when nothing resolved. */
  entityId: string
  /**
   * A provider subscription this delivery superseded and that must stop billing. Carried out
   * of the transaction deliberately: cancelling is a network call to the provider and holding
   * the ParkingOperator row lock across it would let one slow Stripe response stall every
   * other write on that tenant — facility creates included, since they take the same lock.
   */
  cancelProviderSubscriptionId?: string
}

/** What findSubscription resolves, and everything the ordering and terminal guards read. */
interface MatchedSubscription {
  id: string
  status: SubscriptionStatus
  providerSubscriptionId: string | null
  lastEventAt: Date | null
}

/**
 * The provider's vocabulary mapped onto ours, exactly as the driver handler does it and for
 * the same reason: the package leaves `status` undefined for provider states it does not
 * model, and a mechanical uppercase() would turn an unmodelled state into a guess about what
 * a paying tenant is owed.
 */
const STATUS_FROM_PROVIDER: Record<SubscriptionBillingStatus, SubscriptionStatus> = {
  active: SubscriptionStatus.ACTIVE,
  trialing: SubscriptionStatus.TRIALING,
  past_due: SubscriptionStatus.PAST_DUE,
  canceled: SubscriptionStatus.CANCELLED,
}

const AUDIT_ACTION = 'operator_subscription.billing_event_processed'
const SUPERSEDED_ACTION = 'operator_subscription.provider_subscription_cancelled'
const SUPERSEDE_FAILED_ACTION = 'operator_subscription.provider_cancel_failed'

/**
 * This handler's half of the WebhookEvent replay gate, and the reason the ledger's unique key
 * is compound. This route and the driver route are two endpoints on ONE provider account,
 * both subscribed to the same four event types, so the provider delivers one event id to
 * both. Scoped table-wide, the driver endpoint no-opping an operator's checkout as "not a
 * driver event" still claimed the id — and this handler then acknowledged the purchase as a
 * duplicate and never created the subscription the tenant had paid for.
 */
const SURFACE: WebhookSurface = 'operator-subscription'

/**
 * Applies subscription-billing webhook events to OperatorSubscription state. Structurally the
 * twin of DriverSubscriptionEventsService and deliberately NOT a generalisation of it: the two
 * read different catalogs, resolve different subjects, take different row locks and write
 * different audit actions, and a shared handler branching on subscriber type would put the
 * operator's quota semantics one `if` away from a rider's discount.
 *
 * The three guarantees are the driver handler's, unchanged, because they are properties of
 * webhooks rather than of riders:
 *
 * IDEMPOTENCY — the unique WebhookEvent (providerEventId, surface), inserted inside the
 * transaction before any state is touched. A redelivered `checkout.completed` fails at that
 * insert rather than minting a second subscription for one purchase. Only THAT constraint
 * counts as a replay; the same transaction writes OperatorSubscription, whose
 * providerSubscriptionId unique and one-live-row-per-operator partial index raise P2002 of
 * their own, and answering 200 to one of those would file a genuine failure as a harmless
 * duplicate.
 *
 * TERMINAL STATE — CANCELLED is final. Nothing but a fresh checkout reopens a subscription,
 * so a retried `updated` (active) that lands after the `deleted` which really ended the
 * agreement cannot restore facility, tariff and seat quota nobody is paying for.
 *
 * ORDERING — every mutating handler compares the provider's own `eventCreatedAt` against the
 * `lastEventAt` high-water mark on the row and drops anything older, and every applied write
 * moves that mark forward.
 */
@Injectable()
export class OperatorSubscriptionEventsService {
  private readonly logger = new Logger(OperatorSubscriptionEventsService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: SubscriptionBillingService,
  ) {}

  async process(
    event: SubscriptionBillingWebhookEvent,
  ): Promise<OperatorSubscriptionEventOutcome> {
    let result: HandlerResult
    try {
      result = await this.prisma.$transaction(async (tx) => {
        await tx.webhookEvent.create({
          data: {
            providerEventId: event.id,
            surface: SURFACE,
            provider: this.billing.providerName,
            type: event.type,
            payload: event.raw == null ? Prisma.JsonNull : (event.raw as Prisma.InputJsonValue),
          },
        })

        const handled = await this.dispatch(event, tx)

        await tx.webhookEvent.update({
          where: { providerEventId_surface: { providerEventId: event.id, surface: SURFACE } },
          data: { outcome: handled.outcome, processedAt: new Date() },
        })

        // Every non-duplicate delivery leaves a trail, including the ones that changed
        // nothing: "a cancellation arrived for a subscription we do not have" is exactly the
        // kind of fact a billing reconciliation needs and a log line alone will not keep.
        await tx.auditLog.create({
          data: {
            action: AUDIT_ACTION,
            entityType: 'OperatorSubscription',
            entityId: handled.entityId,
            payload: {
              providerEventId: event.id,
              provider: this.billing.providerName,
              type: event.type,
              outcome: handled.outcome,
            },
          },
        })

        return handled
      })
    } catch (error) {
      if (this.isDuplicateEvent(error)) {
        this.logger.log(
          `Operator subscription billing event ${event.id} already processed, acknowledging replay`,
        )
        return 'duplicate'
      }
      throw error
    }

    if (result.cancelProviderSubscriptionId) {
      await this.cancelSuperseded(result.cancelProviderSubscriptionId, event, result.entityId)
    }

    return result.outcome
  }

  /**
   * The tenant bought a second plan while still holding a live, provider-billed one. The old
   * provider subscription would otherwise keep charging their card with nothing in this
   * database pointing at it.
   *
   * Best-effort by design: the purchase is already paid for and applied, so a Stripe outage
   * must not turn a 200 into a redelivery loop over work that is done. The audit row is what
   * stops "best-effort" meaning "silent".
   */
  private async cancelSuperseded(
    providerSubscriptionId: string,
    event: SubscriptionBillingWebhookEvent,
    entityId: string,
  ): Promise<void> {
    const cancelled = await this.billing.cancelSubscriptionBestEffort(providerSubscriptionId, {
      reason: 'superseded_by_checkout',
      providerEventId: event.id,
    })

    await this.prisma.auditLog.create({
      data: {
        action: cancelled ? SUPERSEDED_ACTION : SUPERSEDE_FAILED_ACTION,
        entityType: 'OperatorSubscription',
        entityId,
        payload: {
          providerEventId: event.id,
          provider: this.billing.providerName,
          cancelledProviderSubscriptionId: providerSubscriptionId,
        },
      },
    })
  }

  /**
   * Discriminated on the constraint, not just the code — see the catch in process(). The
   * constraint names BOTH key fields, so the driver surface's own row for the same event id
   * is not even a candidate: it satisfies a different point of the compound key.
   */
  private isDuplicateEvent(error: unknown): boolean {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
      return false
    }
    return isWebhookReplayTarget((error.meta as { target?: unknown } | undefined)?.target)
  }

  private dispatch(
    event: SubscriptionBillingWebhookEvent,
    tx: Prisma.TransactionClient,
  ): Promise<HandlerResult> {
    switch (event.type) {
      case 'checkout.completed':
        return this.applyCheckoutCompleted(event, tx)
      case 'subscription.updated':
        return this.applySubscriptionUpdated(event, tx)
      case 'subscription.deleted':
        return this.applySubscriptionDeleted(event, tx)
      case 'invoice.payment_failed':
        return this.applyPaymentFailed(event, tx)
    }
  }

  /**
   * The purchase itself.
   *
   * NO downgrade guard here, unlike SubscriptionAdminService.assignSubscription, and the
   * omission is deliberate: the tenant has already been charged by the time this runs, so
   * refusing the write would leave them paying for a plan this database never granted. The
   * guard belongs where it can still say no for free — OperatorSubscriptionsSelfService
   * runs it before opening the checkout session.
   */
  private async applyCheckoutCompleted(
    event: SubscriptionBillingWebhookEvent,
    tx: Prisma.TransactionClient,
  ): Promise<HandlerResult> {
    // The engine is generic over its subscriber and the driver surface shares this provider.
    // Anything that is not an operator is not ours to apply, and guessing would write a
    // tenant's plan onto a rider's id.
    if (event.subscriber?.type !== 'operator' || !event.subscriber.id) {
      this.logger.warn(`Checkout event ${event.id} carries no operator subscriber; ignoring`)
      return { outcome: 'not_an_operator', entityId: event.id }
    }
    const operatorId = event.subscriber.id

    if (!event.planId) {
      this.logger.error(`Checkout event ${event.id} for operator ${operatorId} names no plan`)
      return { outcome: 'unmatched_plan', entityId: operatorId }
    }

    // A checkout already applied under a DIFFERENT event id — a dashboard resend, or a
    // replayed backlog. The provider subscription is the purchase's identity, so finding it
    // stored means the money and the grant are both accounted for. Second idempotency line,
    // behind the providerEventId gate.
    if (event.providerSubscriptionId) {
      const already = await tx.operatorSubscription.findUnique({
        where: { providerSubscriptionId: event.providerSubscriptionId },
        select: { id: true },
      })
      if (already) return { outcome: 'already_applied', entityId: already.id }
    }

    // The same lock SubscriptionAdminService and FacilitiesService.create take. It is
    // genuinely load-bearing here rather than merely tidy: it serialises this write against
    // an administrator's assign and against a facility create reading the quota, so the
    // one-live-row-per-operator index turns a race into a wait rather than a violation.
    await tx.$executeRaw`SELECT id FROM "ParkingOperator" WHERE id = ${operatorId} FOR UPDATE`

    const plan = await tx.subscriptionPlan.findFirst({
      where: { id: event.planId, lifecycleStatus: LifecycleStatus.ACTIVE },
      select: { id: true, code: true },
    })
    if (!plan) {
      // The operator has been charged for a plan this database cannot honour — archived
      // mid-checkout, or an event for a plan that never existed here. Never invent one:
      // record it loudly and leave it for a human.
      this.logger.error(
        `Checkout event ${event.id} references unknown or archived operator plan ${event.planId}; reconciliation required`,
      )
      return { outcome: 'unmatched_plan', entityId: operatorId }
    }

    const status = this.status(event) ?? SubscriptionStatus.ACTIVE
    const data = {
      planId: plan.id,
      status,
      currentPeriodStart: new Date(),
      // Left untouched when absent rather than nulled: Stripe's checkout.session.completed
      // often lacks it and the customer.subscription event that follows supplies it.
      ...(event.currentPeriodEnd ? { currentPeriodEnd: event.currentPeriodEnd } : {}),
      ...(event.providerSubscriptionId
        ? { providerSubscriptionId: event.providerSubscriptionId }
        : {}),
      cancelledAt: status === SubscriptionStatus.CANCELLED ? new Date() : null,
      // Nothing to compare against on a purchase — this event IS the row's history. Every
      // later delivery is ordered against the mark it sets here.
      lastEventAt: event.eventCreatedAt,
    }

    const current = await tx.operatorSubscription.findFirst({
      where: { operatorId, status: { in: [...LIVE_SUBSCRIPTION_STATUSES] } },
      select: { id: true, providerSubscriptionId: true },
    })

    /**
     * The tenant already holds a live subscription billed by a DIFFERENT provider
     * subscription — a plan change, which the provider has no way to know is one. Overwriting
     * providerSubscriptionId in place would orphan the old one: still charging the card, and
     * no longer named anywhere in this database.
     *
     * So the old agreement is RETIRED as its own CANCELLED row, keeping its provider id,
     * rather than being overwritten. That is what makes the `subscription.deleted` our own
     * cancellation provokes resolve the retired row and stop there, instead of falling
     * through the customer lookup onto the plan the operator just paid for.
     */
    const superseded =
      current?.providerSubscriptionId != null &&
      current.providerSubscriptionId !== event.providerSubscriptionId
        ? current.providerSubscriptionId
        : undefined

    if (current && superseded) {
      await tx.operatorSubscription.update({
        where: { id: current.id },
        data: { status: SubscriptionStatus.CANCELLED, cancelledAt: new Date() },
      })
    }

    const subscription =
      current && !superseded
        ? await tx.operatorSubscription.update({ where: { id: current.id }, data })
        : await tx.operatorSubscription.create({ data: { ...data, operatorId } })

    return {
      outcome: 'processed',
      entityId: subscription.id,
      cancelProviderSubscriptionId: superseded,
    }
  }

  private async applySubscriptionUpdated(
    event: SubscriptionBillingWebhookEvent,
    tx: Prisma.TransactionClient,
  ): Promise<HandlerResult> {
    const found = await this.findSubscription(event, tx)
    if (!found) return this.unmatched(event)

    if (this.isOutOfOrder(event, found)) return this.outOfOrder(event, found)

    // CANCELLED is terminal, and for an operator the stakes are the driver bug's mirror
    // image: EntitlementService.describe reads status alone, so a resurrected row hands back
    // facility, tariff-plan and staff-seat quota that nobody is paying for. Only a fresh
    // checkout.completed may open a subscription again.
    if (found.status === SubscriptionStatus.CANCELLED) {
      this.logger.warn(
        `Stale subscription.updated event ${event.id} for cancelled subscription ${found.id}`,
      )
      return { outcome: 'stale', entityId: found.id }
    }

    const status = this.status(event)
    // A renewal that names no status we model changes only the period. Defaulting to ACTIVE
    // here would silently reinstate a tenant whose subscription Stripe has paused.
    if (!status && !event.currentPeriodEnd) return { outcome: 'stale', entityId: found.id }

    await tx.operatorSubscription.update({
      where: { id: found.id },
      data: {
        lastEventAt: event.eventCreatedAt,
        ...(status ? { status } : {}),
        ...(event.currentPeriodEnd ? { currentPeriodEnd: event.currentPeriodEnd } : {}),
        ...(status === SubscriptionStatus.CANCELLED ? { cancelledAt: new Date() } : {}),
        // Adopt the provider id when this row was reached through the customer fallback —
        // that is the case this branch exists for, and leaving it unset would make every
        // later event take the slow path.
        ...(found.providerSubscriptionId === null && event.providerSubscriptionId
          ? { providerSubscriptionId: event.providerSubscriptionId }
          : {}),
      },
    })

    return { outcome: 'processed', entityId: found.id }
  }

  private async applySubscriptionDeleted(
    event: SubscriptionBillingWebhookEvent,
    tx: Prisma.TransactionClient,
  ): Promise<HandlerResult> {
    const found = await this.findSubscription(event, tx)
    if (!found) return this.unmatched(event)

    if (this.isOutOfOrder(event, found)) return this.outOfOrder(event, found)

    if (found.status === SubscriptionStatus.CANCELLED) {
      return { outcome: 'already_applied', entityId: found.id }
    }

    // Cancelling drops the tenant back to the default plan, which can leave them over quota.
    // Applied regardless and never refused: the agreement HAS ended upstream, and a database
    // that disagreed would go on granting capacity the provider has stopped billing for.
    // EntitlementService's per-write asserts are what then hold the line, refusing further
    // creates until they are back within the default limits.
    await tx.operatorSubscription.update({
      where: { id: found.id },
      data: {
        status: SubscriptionStatus.CANCELLED,
        cancelledAt: new Date(),
        lastEventAt: event.eventCreatedAt,
      },
    })

    return { outcome: 'processed', entityId: found.id }
  }

  private async applyPaymentFailed(
    event: SubscriptionBillingWebhookEvent,
    tx: Prisma.TransactionClient,
  ): Promise<HandlerResult> {
    const found = await this.findSubscription(event, tx)
    if (!found) return this.unmatched(event)

    if (this.isOutOfOrder(event, found)) return this.outOfOrder(event, found)

    // A failed invoice arriving after the tenant already cancelled must not resurrect the row
    // into a live state — CANCELLED is terminal, and PAST_DUE is not. Doing so would also put
    // two live rows on one operator if they had since resubscribed, which the partial unique
    // index would reject outright.
    if (found.status === SubscriptionStatus.CANCELLED) {
      this.logger.warn(
        `Stale invoice.payment_failed event ${event.id} for cancelled subscription ${found.id}`,
      )
      return { outcome: 'stale', entityId: found.id }
    }
    if (found.status === SubscriptionStatus.PAST_DUE) {
      return { outcome: 'already_applied', entityId: found.id }
    }

    await tx.operatorSubscription.update({
      where: { id: found.id },
      data: { status: SubscriptionStatus.PAST_DUE, lastEventAt: event.eventCreatedAt },
    })

    return { outcome: 'processed', entityId: found.id }
  }

  /**
   * The general ordering guard, and the reason `lastEventAt` exists. It is NOT specific to
   * cancellation: an `active` event carrying last cycle's period end, redelivered after the
   * renewal that moved it forward, would roll a paying tenant's access back by a month. A
   * strict `<` so two events the provider stamped in the same second both apply — the
   * transaction serialises them, and dropping the second would be worse than applying it.
   */
  private isOutOfOrder(
    event: SubscriptionBillingWebhookEvent,
    found: MatchedSubscription,
  ): boolean {
    return found.lastEventAt !== null && event.eventCreatedAt < found.lastEventAt
  }

  /**
   * Dropped, but acknowledged and recorded. The WebhookEvent row is still written by the
   * caller, so the provider gets its 200 and never redelivers, and the audit row says a
   * delivery arrived and changed nothing — which is the only way a reconciliation can tell
   * "we dropped a stale event" apart from "we never received it".
   */
  private outOfOrder(
    event: SubscriptionBillingWebhookEvent,
    found: MatchedSubscription,
  ): HandlerResult {
    this.logger.warn(
      `Out-of-order ${event.type} event ${event.id} for subscription ${found.id}: ` +
        `created ${event.eventCreatedAt.toISOString()}, last applied ${found.lastEventAt?.toISOString()}`,
    )
    return { outcome: 'stale', entityId: found.id }
  }

  /**
   * providerSubscriptionId first, then the operator behind providerCustomerId. The fallback
   * is load-bearing rather than defensive: Stripe's own docs note that
   * checkout.session.completed may arrive without the subscription expanded, so the
   * customer.subscription.updated that carries the period end can reach a row that has no
   * provider id stored yet.
   */
  private async findSubscription(
    event: SubscriptionBillingWebhookEvent,
    tx: Prisma.TransactionClient,
  ): Promise<MatchedSubscription | null> {
    const select = {
      id: true,
      status: true,
      providerSubscriptionId: true,
      lastEventAt: true,
    }

    if (event.providerSubscriptionId) {
      const byProviderId = await tx.operatorSubscription.findUnique({
        where: { providerSubscriptionId: event.providerSubscriptionId },
        select,
      })
      if (byProviderId) return byProviderId
    }

    if (!event.providerCustomerId) return null

    const customer = await tx.operatorBillingCustomer.findUnique({
      where: {
        provider_providerCustomerId: {
          provider: this.billing.providerName,
          providerCustomerId: event.providerCustomerId,
        },
      },
      select: { operatorId: true },
    })
    if (!customer) return null

    return tx.operatorSubscription.findFirst({
      where: { operatorId: customer.operatorId, status: { in: [...LIVE_SUBSCRIPTION_STATUSES] } },
      select,
    })
  }

  /**
   * Logged and acknowledged, never thrown. A 5xx here would make the provider redeliver an
   * event that will never resolve — and after enough failures Stripe disables the endpoint,
   * taking the events that DO matter with it. The audit row is the reconciliation trail.
   */
  private unmatched(event: SubscriptionBillingWebhookEvent): HandlerResult {
    this.logger.warn(
      `Subscription event ${event.id} (${event.type}) matched no operator subscription ` +
        `(subscription=${event.providerSubscriptionId ?? 'none'}, customer=${event.providerCustomerId ?? 'none'})`,
    )
    return { outcome: 'unmatched_subscription', entityId: event.id }
  }

  private status(event: SubscriptionBillingWebhookEvent): SubscriptionStatus | undefined {
    return event.status ? STATUS_FROM_PROVIDER[event.status] : undefined
  }
}
