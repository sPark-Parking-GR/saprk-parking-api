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

export type DriverSubscriptionEventOutcome =
  | 'processed'
  | 'duplicate'
  | 'not_a_driver'
  | 'unmatched_plan'
  | 'unmatched_subscription'
  | 'already_applied'
  | 'stale'

interface HandlerResult {
  outcome: Exclude<DriverSubscriptionEventOutcome, 'duplicate'>
  /** What the audit row is filed against; the event's own id when nothing resolved. */
  entityId: string
  /**
   * A provider subscription this delivery superseded and that must stop billing. Carried out
   * of the transaction deliberately: cancelling is a network call to the provider and holding
   * a row lock across it would let one slow Stripe response stall every other write on that
   * rider.
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
 * The provider's vocabulary mapped onto ours. Explicit rather than an uppercase() because
 * the two sets are allowed to diverge: the package deliberately leaves `status` undefined
 * for provider states it does not model (Stripe's `incomplete`, `paused`), and a mechanical
 * conversion would turn an unmodelled state into a guess about what a rider is owed.
 */
const STATUS_FROM_PROVIDER: Record<SubscriptionBillingStatus, SubscriptionStatus> = {
  active: SubscriptionStatus.ACTIVE,
  trialing: SubscriptionStatus.TRIALING,
  past_due: SubscriptionStatus.PAST_DUE,
  canceled: SubscriptionStatus.CANCELLED,
}

const AUDIT_ACTION = 'driver_subscription.billing_event_processed'
const SUPERSEDED_ACTION = 'driver_subscription.provider_subscription_cancelled'
const SUPERSEDE_FAILED_ACTION = 'driver_subscription.provider_cancel_failed'

/**
 * This handler's half of the WebhookEvent replay gate. The driver and operator subscription
 * endpoints are two endpoints on ONE provider account, both subscribed to the same four event
 * types, so the provider delivers one event id to both. Scoping the ledger's unique key by
 * surface is what stops the endpoint that commits first from making the other acknowledge a
 * delivery it never processed — an operator's checkout swallowed by the driver route means a
 * tenant charged with no subscription.
 */
const SURFACE: WebhookSurface = 'driver-subscription'

/**
 * Applies subscription-billing webhook events to DriverSubscription state. The webhook, not
 * the client, is authoritative: a rider who pays on the hosted page and never returns to the
 * app still gets their plan here.
 *
 * IDEMPOTENCY IS THE WHOLE DESIGN, and it is the same insert-first gate PaymentEventsService
 * uses — the unique WebhookEvent (providerEventId, surface), written inside the transaction
 * before any state is touched. A redelivered `checkout.completed` therefore fails at that
 * insert rather than minting a second subscription for one purchase. The per-handler state
 * checks below are the second line: a provider that reissues an event under a NEW id (which
 * Stripe does not, but a resend from a dashboard or a replayed backlog can) still has to find
 * the write already applied and do nothing.
 *
 * ORDERING IS THE THIRD LINE. Webhooks are not delivered in order: a delivery that fails is
 * retried BEHIND the ones that overtook it, so an `active` update can land after the
 * cancellation that really ended the agreement. Every mutating handler therefore compares the
 * provider's own `eventCreatedAt` against the `lastEventAt` high-water mark on the row and
 * drops anything older, and every applied write moves that mark forward.
 */
@Injectable()
export class DriverSubscriptionEventsService {
  private readonly logger = new Logger(DriverSubscriptionEventsService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: SubscriptionBillingService,
  ) {}

  async process(event: SubscriptionBillingWebhookEvent): Promise<DriverSubscriptionEventOutcome> {
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
            entityType: 'DriverSubscription',
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
      // ONLY the (providerEventId, surface) constraint means "already processed by THIS
      // handler". The same transaction also writes DriverSubscription, whose
      // providerSubscriptionId unique and partial one-live-row-per-rider index can fire their
      // own P2002 — and answering 200 to one of those would classify a genuine, unhandled
      // failure as a harmless replay, so the provider never retries and the event is lost for
      // good. Anything else propagates.
      if (this.isDuplicateEvent(error)) {
        this.logger.log(
          `Subscription billing event ${event.id} already processed, acknowledging replay`,
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
   * The rider bought a second plan while still holding a live, provider-billed one. The old
   * provider subscription would otherwise keep charging their card with nothing in this
   * database pointing at it, which is the failure mode that made this worth doing at all.
   *
   * Best-effort by design, mirroring NotificationsService.safeSend: the purchase is already
   * paid for and applied, so a Stripe outage must not turn a 200 into a redelivery loop over
   * work that is done. The audit row is what stops "best-effort" meaning "silent" — it is the
   * durable trail a billing reconciliation reads when a rider reports being charged twice.
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
        entityType: 'DriverSubscription',
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
   * constraint names BOTH key fields, so the operator surface's own row for the same event id
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
   * The purchase itself. Upserts the rider's single live subscription rather than always
   * creating: the partial unique index DriverSubscription_user_live_key permits exactly one
   * non-CANCELLED row per rider, so a rider upgrading from a plan they already hold has to
   * move the existing row, not add a second one.
   */
  private async applyCheckoutCompleted(
    event: SubscriptionBillingWebhookEvent,
    tx: Prisma.TransactionClient,
  ): Promise<HandlerResult> {
    // The engine is generic over its subscriber, and operator self-serve checkout is the
    // planned second consumer of the same endpoint's provider. Anything that is not a driver
    // is not ours to apply, and guessing would write a rider's plan onto an operator id.
    if (event.subscriber?.type !== 'driver' || !event.subscriber.id) {
      this.logger.warn(`Checkout event ${event.id} carries no driver subscriber; ignoring`)
      return { outcome: 'not_a_driver', entityId: event.id }
    }
    const userId = event.subscriber.id

    if (!event.planId) {
      this.logger.error(`Checkout event ${event.id} for driver ${userId} names no plan`)
      return { outcome: 'unmatched_plan', entityId: userId }
    }

    // A checkout already applied under a DIFFERENT event id — a dashboard resend, or a
    // replayed backlog. The provider subscription is the purchase's identity, so finding it
    // already stored means the money and the grant are both accounted for. Second
    // idempotency line, behind the providerEventId gate.
    if (event.providerSubscriptionId) {
      const already = await tx.driverSubscription.findUnique({
        where: { providerSubscriptionId: event.providerSubscriptionId },
        select: { id: true },
      })
      if (already) return { outcome: 'already_applied', entityId: already.id }
    }

    // Serialises against DriverSubscriptionAdminService's assign path, which takes the same
    // lock: an administrator assigning a plan while a rider's checkout completes must
    // produce one live row, and the lock turns that race into a wait rather than a
    // constraint violation on whichever side lost.
    await tx.$executeRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`

    const plan = await tx.driverSubscriptionPlan.findFirst({
      where: { id: event.planId, lifecycleStatus: LifecycleStatus.ACTIVE },
      select: { id: true, code: true },
    })
    if (!plan) {
      // The rider has been charged for a plan this database cannot honour — archived
      // mid-checkout, or an event for a plan that never existed here. Never invent one:
      // record it loudly and leave it for a human, exactly as the payment path does with a
      // charge it cannot attach.
      this.logger.error(
        `Checkout event ${event.id} references unknown or archived driver plan ${event.planId}; reconciliation required`,
      )
      return { outcome: 'unmatched_plan', entityId: userId }
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

    const current = await tx.driverSubscription.findFirst({
      where: { userId, status: { in: [...LIVE_SUBSCRIPTION_STATUSES] } },
      select: { id: true, providerSubscriptionId: true },
    })

    /**
     * The rider already holds a live subscription billed by a DIFFERENT provider
     * subscription — a plan change, which the provider has no way to know is one. Overwriting
     * providerSubscriptionId in place would orphan the old one: still charging the card, and
     * no longer named anywhere in this database.
     *
     * So the old agreement is RETIRED as its own CANCELLED row, keeping its provider id,
     * rather than being overwritten. That is what makes the `subscription.deleted` our own
     * cancellation provokes resolve the retired row and stop there, instead of falling
     * through the customer lookup onto the new subscription and cancelling the plan the
     * rider just paid for.
     */
    const superseded =
      current?.providerSubscriptionId != null &&
      current.providerSubscriptionId !== event.providerSubscriptionId
        ? current.providerSubscriptionId
        : undefined

    if (current && superseded) {
      await tx.driverSubscription.update({
        where: { id: current.id },
        data: { status: SubscriptionStatus.CANCELLED, cancelledAt: new Date() },
      })
    }

    const subscription =
      current && !superseded
        ? await tx.driverSubscription.update({ where: { id: current.id }, data })
        : await tx.driverSubscription.create({ data: { ...data, userId } })

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

    // CANCELLED is terminal here for the same reason it is in the two handlers below, and its
    // absence was the live bug: Stripe retrying a failed `updated` (active) AFTER the
    // `deleted` that really ended the agreement flipped the row back to ACTIVE, and
    // DriverEntitlementService.resolveEffective reads status alone — so the rider kept their
    // discount forever, unpaid. Only a fresh checkout.completed may open a subscription again.
    if (found.status === SubscriptionStatus.CANCELLED) {
      this.logger.warn(
        `Stale subscription.updated event ${event.id} for cancelled subscription ${found.id}`,
      )
      return { outcome: 'stale', entityId: found.id }
    }

    const status = this.status(event)
    // A renewal that names no status we model changes only the period. Defaulting to ACTIVE
    // here would silently reinstate a rider whose subscription Stripe has paused.
    if (!status && !event.currentPeriodEnd) return { outcome: 'stale', entityId: found.id }

    await tx.driverSubscription.update({
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

    await tx.driverSubscription.update({
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

    // Out-of-order guard: a failed invoice arriving after the rider already cancelled must
    // not resurrect the row into a live state — CANCELLED is terminal, and PAST_DUE is not.
    // Doing so would also put two live rows on one rider if they had since resubscribed,
    // which the partial unique index would reject outright.
    if (found.status === SubscriptionStatus.CANCELLED) {
      this.logger.warn(
        `Stale invoice.payment_failed event ${event.id} for cancelled subscription ${found.id}`,
      )
      return { outcome: 'stale', entityId: found.id }
    }
    if (found.status === SubscriptionStatus.PAST_DUE) {
      return { outcome: 'already_applied', entityId: found.id }
    }

    await tx.driverSubscription.update({
      where: { id: found.id },
      data: { status: SubscriptionStatus.PAST_DUE, lastEventAt: event.eventCreatedAt },
    })

    return { outcome: 'processed', entityId: found.id }
  }

  /**
   * The general ordering guard, and the reason `lastEventAt` exists. It is NOT specific to
   * cancellation: an `active` event carrying last cycle's period end, redelivered after the
   * renewal that moved it forward, would roll a paying rider's access back by a month. A
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
   * providerSubscriptionId first, then the rider behind providerCustomerId. The fallback is
   * load-bearing rather than defensive: Stripe's own docs note that checkout.session.completed
   * may arrive without the subscription expanded, so the customer.subscription.updated that
   * carries the period end can reach a row that has no provider id stored yet. The customer
   * lookup is what lets that event still find its rider — and applySubscriptionUpdated then
   * writes the id in, so it happens at most once per subscription.
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
      const byProviderId = await tx.driverSubscription.findUnique({
        where: { providerSubscriptionId: event.providerSubscriptionId },
        select,
      })
      if (byProviderId) return byProviderId
    }

    if (!event.providerCustomerId) return null

    const customer = await tx.driverBillingCustomer.findUnique({
      where: {
        provider_providerCustomerId: {
          provider: this.billing.providerName,
          providerCustomerId: event.providerCustomerId,
        },
      },
      select: { userId: true },
    })
    if (!customer) return null

    return tx.driverSubscription.findFirst({
      where: { userId: customer.userId, status: { in: [...LIVE_SUBSCRIPTION_STATUSES] } },
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
      `Subscription event ${event.id} (${event.type}) matched no driver subscription ` +
        `(subscription=${event.providerSubscriptionId ?? 'none'}, customer=${event.providerCustomerId ?? 'none'})`,
    )
    return { outcome: 'unmatched_subscription', entityId: event.id }
  }

  private status(event: SubscriptionBillingWebhookEvent): SubscriptionStatus | undefined {
    return event.status ? STATUS_FROM_PROVIDER[event.status] : undefined
  }
}
