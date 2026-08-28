import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { LifecycleStatus, Prisma, type SubscriptionPlan } from '@prisma/client'
import type {
  AuthUser,
  BillingInterval,
  EntitlementSource,
  Entitlements,
  OperatorUsage,
  SubscriptionStatus,
} from '@spark/types'
import { OperatorScopeService, targetOperatorId } from '../common/authz/operator-scope.service'
import {
  AlreadySubscribedToPlanError,
  SubscriptionPlanNotFoundError,
} from '../common/errors/domain.errors'
import { NotificationsService } from '../notifications/notifications.service'
import { OperatorAccessService } from '../operators/operator-access.service'
import { OperatorNotFoundError } from '../operators/operators.types'
import { PrismaService } from '../prisma/prisma.service'
import { SubscriptionBillingService } from '../subscription-billing/subscription-billing.service'
import type {
  RequestOperatorUpgradeDto,
  StartOperatorCheckoutDto,
} from './dto/operator-subscriptions-self.dto'
import { EntitlementService } from './entitlement.service'
import { entitlementsSchema } from './entitlements.schema'
import { LIVE_SUBSCRIPTION_STATUSES } from './subscriptions.constants'

/**
 * How long one operator's checkout for one plan collapses onto a single provider session.
 * Long enough to absorb a double click, a reload and a retried request; short enough that an
 * operator who abandoned the page and came back is not handed a session they walked away
 * from. The driver window, for the same reasons.
 */
const CHECKOUT_IDEMPOTENCY_WINDOW_MS = 10 * 60_000

/**
 * The operator-facing catalog entry. A strict subset of PlanView: `sortOrder`, the live
 * subscriber count and every lifecycle column are administration facts, and a public endpoint
 * that leaked them would report how many tenants are on each plan to anyone who asked.
 */
export interface OperatorPlanCatalogItem {
  id: string
  code: string
  name: string
  description: string | null
  priceCents: number
  currency: string
  interval: BillingInterval
  entitlements: Entitlements
}

/**
 * What an operator sees about their own plan. The same entitlement, source and usage fields
 * the admin surface reports, minus the ones that exist only for administration —
 * `entitlementOverride` and `providerSubscriptionId` describe how sPark books the account,
 * not what the customer bought, and `operatorId`/`subscriptionId` are ids the caller already
 * implies and can do nothing with.
 *
 * Dates are serialised to ISO strings here rather than left as `Date`, matching
 * DriverSubscriptionSelfView: the client contract should be a property of this file, not of
 * whichever JSON encoder happens to be installed.
 */
export interface OperatorSubscriptionSelfView {
  planCode: string | null
  planName: string | null
  status: SubscriptionStatus | null
  currentPeriodStart: string | null
  currentPeriodEnd: string | null
  trialEndsAt: string | null
  cancelAtPeriodEnd: boolean
  source: EntitlementSource
  entitlements: Entitlements
  usage: OperatorUsage
}

/**
 * `requestId` is the audit row, so a later support conversation can name the exact request.
 * `delivered` mirrors InviteIssued: this endpoint's whole effect is a record plus an email,
 * and a caller told only "accepted" cannot tell a filed request from a silently dropped one.
 */
export interface OperatorUpgradeRequestReceipt {
  requestId: string
  delivered: boolean
}

/**
 * The self-serve half of operator billing: the public catalog, the operator's own view of
 * what they hold, the checkout hand-off, and the manual request that remains for plans no
 * one may buy unattended.
 *
 * This service never marks anyone subscribed. `startCheckout` only opens a session at the
 * provider; every write a PAYMENT causes lands in OperatorSubscriptionEventsService, so an
 * operator who pays on the hosted page and closes the tab still gets their plan.
 * `requestUpgrade` writes no billing state at all — which is why the whole surface is gated
 * on `org:billing.view`; see the controller for why a view scope is the right gate here.
 *
 * Entitlement resolution is EntitlementService's, unchanged and un-duplicated: this service
 * only decides WHICH operator to resolve, and that decision never reads a caller-supplied id.
 */
@Injectable()
export class OperatorSubscriptionsSelfService {
  private readonly logger = new Logger(OperatorSubscriptionsSelfService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementService,
    private readonly access: OperatorAccessService,
    private readonly operatorScope: OperatorScopeService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
    private readonly billing: SubscriptionBillingService,
  ) {}

  async listPublicPlans(): Promise<OperatorPlanCatalogItem[]> {
    const plans = await this.prisma.subscriptionPlan.findMany({
      // The lifecycle predicate SubscriptionAdminService.listPlans uses for its unarchived
      // listing, narrowed by isPublic: a sales-negotiated plan exists only for an
      // administrator to assign by hand and must never appear in a public catalog.
      where: { lifecycleStatus: LifecycleStatus.ACTIVE, isPublic: true },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    })

    return plans.map((plan) => this.toCatalogItem(plan))
  }

  async getMySubscription(actor: AuthUser): Promise<OperatorSubscriptionSelfView> {
    const operatorId = await this.resolveOwnOperator(actor)

    const [described, subscription] = await Promise.all([
      this.entitlements.describe(operatorId),
      this.prisma.operatorSubscription.findFirst({
        where: { operatorId, status: { in: [...LIVE_SUBSCRIPTION_STATUSES] } },
        select: {
          currentPeriodStart: true,
          currentPeriodEnd: true,
          trialEndsAt: true,
          cancelAtPeriodEnd: true,
        },
      }),
    ])

    return {
      planCode: described.planCode,
      planName: described.planName,
      status: described.status,
      currentPeriodStart: subscription?.currentPeriodStart?.toISOString() ?? null,
      currentPeriodEnd: subscription?.currentPeriodEnd?.toISOString() ?? null,
      trialEndsAt: subscription?.trialEndsAt?.toISOString() ?? null,
      cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
      source: described.source,
      entitlements: described.entitlements,
      usage: described.usage,
    }
  }

  /**
   * The self-serve hand-off, and the primary path for any plan an operator may buy
   * unattended. Structurally DriverSubscriptionsSelfService.startCheckout, with the two
   * differences an operator has: the return URLs are web URLs rather than the app's custom
   * scheme, and a plan change is checked against current usage before a card is charged.
   */
  async startCheckout(
    actor: AuthUser,
    dto: StartOperatorCheckoutDto,
  ): Promise<{ checkoutUrl: string }> {
    const operatorId = await this.resolveOwnOperator(actor)

    // 404 rather than 409, and one answer for all three of missing, archived and non-public:
    // an operator may only ever address a plan in their own catalog, so anything outside it
    // must be indistinguishable from a plan that does not exist. The same not-found masking
    // requestUpgrade and every other caller-named resource in this codebase uses.
    const plan = await this.loadPublicPlan(dto.planId)

    /**
     * An operator holds at most one live subscription — `OperatorSubscription_operator_live_key`
     * says so in the database. Without this check, buying the plan they are already on would
     * open a SECOND provider subscription for the same thing, and applyCheckoutCompleted would
     * then have two agreements to reconcile onto one row.
     *
     * Only the same-plan case is refused. A DIFFERENT plan is a genuine upgrade or downgrade,
     * and the old provider subscription is cancelled when the new one activates — in
     * applyCheckoutCompleted, which is the first moment the operator has actually paid. Doing
     * it here would strip a tenant of the plan they still hold the instant they opened a
     * checkout page they might abandon.
     */
    const live = await this.prisma.operatorSubscription.findFirst({
      where: { operatorId, status: { in: [...LIVE_SUBSCRIPTION_STATUSES] } },
      select: { planId: true },
    })
    if (live?.planId === plan.id) throw new AlreadySubscribedToPlanError(plan.code)

    /**
     * The one guard the driver path has no equivalent of, and the reason it runs HERE rather
     * than in the webhook: operator entitlements cap countable resources the tenant has
     * already created, so a self-serve downgrade can be sold for a plan this database then
     * cannot honour. The webhook is too late — the card has been charged by then, and
     * refusing the write would leave them paying for a plan they never received. This is the
     * same assertion SubscriptionAdminService runs before an administrator's assign, and it
     * reports every violation so one refusal tells the operator the whole cleanup.
     */
    await this.entitlements.assertUsageFitsEntitlements(
      operatorId,
      entitlementsSchema.parse(plan.entitlements),
    )

    const providerCustomerId = await this.getOrCreateCustomer(operatorId, actor.email)
    const webAppUrl = this.config.getOrThrow<string>('WEB_APP_URL').replace(/\/+$/, '')

    const { checkoutUrl } = await this.billing.createCheckoutSession({
      providerCustomerId,
      subscriber: { type: 'operator', id: operatorId },
      planId: plan.id,
      planCode: plan.code,
      priceCents: plan.priceCents,
      currency: plan.currency,
      interval: plan.interval,
      // Deterministic without being permanent: a double-clicked upgrade button replays the
      // first hosted session instead of opening a second live one, while an operator who
      // abandons the page and returns later still gets a fresh session rather than a stale
      // URL. Keyed on the OPERATOR, not the admin who clicked — two admins of one tenant
      // upgrading at once must not open two subscriptions for one business.
      idempotencyKey: this.checkoutIdempotencyKey(operatorId, plan.id),
      // Fixed, and built entirely server-side. A return URL the caller could influence is an
      // open redirect on the one page an operator reaches with a payment credential in hand.
      successUrl: `${webAppUrl}/dashboard/billing?checkout=success`,
      cancelUrl: `${webAppUrl}/dashboard/billing?checkout=cancel`,
    })

    return { checkoutUrl }
  }

  private checkoutIdempotencyKey(operatorId: string, planId: string): string {
    const bucket = Math.floor(Date.now() / CHECKOUT_IDEMPOTENCY_WINDOW_MS)
    return `checkout_operator_${operatorId}_${planId}_${bucket}`
  }

  /**
   * The tenant's provider identity, created once and reused for every later checkout — see
   * the OperatorBillingCustomer model comment for why it is anchored to the operator rather
   * than to the admin who happened to open the first session.
   *
   * `email` is the acting administrator's, because a provider customer needs a contact and an
   * operator has no address of its own. It is what the provider mails receipts to; the row it
   * keys is still the tenant's, so a later checkout by a different admin reaches the same
   * customer and the same invoice history.
   */
  private async getOrCreateCustomer(operatorId: string, email: string): Promise<string> {
    const provider = this.billing.providerName

    const existing = await this.prisma.operatorBillingCustomer.findUnique({
      where: { operatorId },
    })
    if (existing && existing.provider === provider) return existing.providerCustomerId

    const { providerCustomerId } = await this.billing.getOrCreateCustomer({
      subscriber: { type: 'operator', id: operatorId },
      email,
    })

    if (existing) {
      // The deployment changed providers under a tenant who already had an identity at the
      // old one. Their `cus_mock_…` means nothing to Stripe, so the row is repointed rather
      // than trusted; the old customer stays at the old provider, where its history lives.
      this.logger.warn(
        `Operator ${operatorId} had a ${existing.provider} billing customer; repointing to ${provider}`,
      )
      await this.prisma.operatorBillingCustomer.update({
        where: { operatorId },
        data: { provider, providerCustomerId },
      })
      return providerCustomerId
    }

    try {
      await this.prisma.operatorBillingCustomer.create({
        data: { operatorId, provider, providerCustomerId },
      })
    } catch (error) {
      // Two first-ever checkouts racing — genuinely likely here, where two admins of one
      // operator can click upgrade at the same moment. The primary key on operatorId makes
      // one lose, and the loser re-reads rather than failing: both provider calls resolved to
      // the same customer anyway (Stripe dedupes on a deterministic idempotency key, the mock
      // on the subscriber key), so the stored row is the right answer.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const row = await this.prisma.operatorBillingCustomer.findUniqueOrThrow({
          where: { operatorId },
        })
        return row.providerCustomerId
      }
      throw error
    }

    return providerCustomerId
  }

  /**
   * Records that an operator asked to change plan and tells a human. Deliberately inert
   * otherwise: it moves no tenant onto any plan, so the worst a flood of these can do is fill
   * the audit log and an inbox — which is what the route's throttle is for.
   */
  async requestUpgrade(
    actor: AuthUser,
    dto: RequestOperatorUpgradeDto,
  ): Promise<OperatorUpgradeRequestReceipt> {
    const operatorId = await this.resolveOwnOperator(actor)

    const operator = await this.prisma.parkingOperator.findUnique({
      where: { id: operatorId },
      select: { id: true, name: true },
    })
    if (!operator) throw new OperatorNotFoundError(operatorId)

    // Validated rather than dropped: a request naming a plan that no longer exists is a
    // customer pointing at something they saw, and answering it silently as "call me" loses
    // the one fact the administrator needs. Same not-found masking every caller-named
    // resource uses — missing, archived and non-public are one answer.
    const requestedPlan = dto.requestedPlanId
      ? await this.loadPublicPlan(dto.requestedPlanId)
      : null

    const audit = await this.prisma.auditLog.create({
      data: {
        actorId: actor.id,
        actorRole: actor.role,
        action: 'operator_subscription.upgrade_requested',
        // ParkingOperator rather than the OperatorSubscription its `operator_subscription.*`
        // siblings name: a request routinely arrives from a tenant that has no subscription
        // row at all, and the entity an administrator opens to action it is the operator.
        entityType: 'ParkingOperator',
        entityId: operator.id,
        payload: {
          ...(requestedPlan
            ? { requestedPlanId: requestedPlan.id, requestedPlanCode: requestedPlan.code }
            : {}),
          ...(dto.message ? { message: dto.message } : {}),
        } satisfies Prisma.InputJsonValue,
      },
      select: { id: true },
    })

    const delivered = await this.notifyPlatform(actor, operator, requestedPlan, dto.message ?? null)

    return { requestId: audit.id, delivered }
  }

  /**
   * WHICH operator this caller is. Derived from their own memberships and never from the
   * request: there is no operator id on any route of this controller, so there is nothing for
   * a caller to substitute.
   *
   * `assertScope` is the authoritative half of the authorization the controller's decorator
   * already asked for, per the both-layers rule — and it is what makes STAFF structurally
   * incapable of reaching billing, since scopesFor() filters `org:billing.view` out of a
   * staff membership at read time however the row was written.
   */
  private async resolveOwnOperator(actor: AuthUser): Promise<string> {
    const scope = await this.operatorScope.resolve(actor)
    const operatorId = targetOperatorId(scope, undefined)
    await this.access.assertScope(actor, operatorId, 'org:billing.view')
    return operatorId
  }

  private async loadPublicPlan(planId: string): Promise<SubscriptionPlan> {
    const plan = await this.prisma.subscriptionPlan.findFirst({
      where: { id: planId, lifecycleStatus: LifecycleStatus.ACTIVE, isPublic: true },
    })
    if (!plan) throw new SubscriptionPlanNotFoundError(planId)
    return plan
  }

  /**
   * Unset contact address skips the mail and says so in the logs rather than failing the
   * request or refusing to boot. The request is already durable in the audit log by the time
   * this runs, and safeSend's whole philosophy is that a notification channel must not be
   * able to fail a write — a marketing inbox nobody configured is exactly that case.
   */
  private async notifyPlatform(
    actor: AuthUser,
    operator: { id: string; name: string },
    requestedPlan: SubscriptionPlan | null,
    message: string | null,
  ): Promise<boolean> {
    const to = this.config.get<string>('PLATFORM_BILLING_CONTACT_EMAIL')
    if (!to) {
      this.logger.warn(
        { operatorId: operator.id },
        'PLATFORM_BILLING_CONTACT_EMAIL is unset; upgrade request recorded but not emailed',
      )
      return false
    }

    return this.notifications.sendOperatorUpgradeRequest({
      to,
      operatorName: operator.name,
      requesterName: actor.displayName ?? actor.email,
      requesterEmail: actor.email,
      requestedPlanName: requestedPlan?.name ?? null,
      message,
      operatorUrl: `${this.config.getOrThrow<string>('WEB_APP_URL')}/admin/operators/${operator.id}`,
    })
  }

  private toCatalogItem(plan: SubscriptionPlan): OperatorPlanCatalogItem {
    return {
      id: plan.id,
      code: plan.code,
      name: plan.name,
      description: plan.description,
      priceCents: plan.priceCents,
      currency: plan.currency,
      interval: plan.interval,
      entitlements: entitlementsSchema.parse(plan.entitlements),
    }
  }
}
