import { Injectable, Logger } from '@nestjs/common'
import { LifecycleStatus, Prisma, type SubscriptionStatus } from '@prisma/client'
import type { AuthUser, BillingInterval } from '@spark/types'
import {
  AlreadySubscribedToPlanError,
  SubscriptionPlanNotFoundError,
} from '../common/errors/domain.errors'
import { PrismaService } from '../prisma/prisma.service'
import { SubscriptionBillingService } from '../subscription-billing/subscription-billing.service'
import {
  DriverEntitlementService,
  type DriverEntitlementSource,
} from './driver-entitlement.service'
import { driverEntitlementsSchema, type DriverEntitlements } from './driver-entitlements.schema'
import { LIVE_SUBSCRIPTION_STATUSES } from './subscriptions.constants'

/**
 * The fixed contract the mobile app is built against. A custom scheme, not an https link:
 * the checkout page runs in an external browser and this is what hands control back to the
 * app. Changing either string silently strands every rider on the payment page.
 */
export const CHECKOUT_SUCCESS_URL = 'spark://subscription-return?status=success'
export const CHECKOUT_CANCEL_URL = 'spark://subscription-return?status=cancel'

/**
 * How long one rider's checkout for one plan collapses onto a single provider session. Long
 * enough to absorb a double tap, an app relaunch and a retried request; short enough that a
 * rider who abandoned the page and returned is not handed back a session they already walked
 * away from.
 */
const CHECKOUT_IDEMPOTENCY_WINDOW_MS = 10 * 60_000

/**
 * The rider-facing catalog entry. A strict subset of DriverPlanView: sortOrder, the live
 * subscriber count and every lifecycle column are administration facts, and a public
 * endpoint that leaked them would report how many people are on each plan to anyone who
 * asked.
 */
export interface DriverPlanCatalogItem {
  id: string
  code: string
  name: string
  description: string | null
  priceCents: number
  currency: string
  interval: BillingInterval
  entitlements: DriverEntitlements
}

/**
 * What a rider sees about their own subscription. `currentPeriodEnd` is serialised here
 * rather than left as a Date: the mobile client is already built against an ISO string, and
 * relying on the JSON serialiser to produce one would make the contract a property of
 * whatever encoder happens to be installed.
 */
export interface DriverSubscriptionSelfView {
  planCode: string | null
  planName: string | null
  status: SubscriptionStatus | null
  currentPeriodEnd: string | null
  entitlements: DriverEntitlements
  source: DriverEntitlementSource
}

/**
 * The self-serve half of driver billing: the public catalog, the rider's own view of what
 * they hold, and the checkout hand-off. Every write a PAYMENT causes lands in
 * DriverSubscriptionEventsService instead — this service never marks anyone subscribed, it
 * only opens a session at the provider and waits to be told the money moved.
 */
@Injectable()
export class DriverSubscriptionsSelfService {
  private readonly logger = new Logger(DriverSubscriptionsSelfService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: DriverEntitlementService,
    private readonly billing: SubscriptionBillingService,
  ) {}

  async listPublicPlans(): Promise<DriverPlanCatalogItem[]> {
    const plans = await this.prisma.driverSubscriptionPlan.findMany({
      // Same lifecycle predicate DriverSubscriptionAdminService.listPlans uses for its
      // unarchived listing, narrowed by isPublic: a sales-negotiated plan exists only for an
      // administrator to assign by hand and must never appear in the rider's catalog.
      where: { lifecycleStatus: LifecycleStatus.ACTIVE, isPublic: true },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    })

    return plans.map((plan) => ({
      id: plan.id,
      code: plan.code,
      name: plan.name,
      description: plan.description,
      priceCents: plan.priceCents,
      currency: plan.currency,
      interval: plan.interval,
      entitlements: driverEntitlementsSchema.parse(plan.entitlements),
    }))
  }

  async getMySubscription(userId: string): Promise<DriverSubscriptionSelfView> {
    const [effective, subscription] = await Promise.all([
      this.entitlements.resolveEffective(userId),
      this.prisma.driverSubscription.findFirst({
        where: { userId, status: { in: [...LIVE_SUBSCRIPTION_STATUSES] } },
        select: { currentPeriodEnd: true },
      }),
    ])

    return {
      planCode: effective.planCode,
      planName: effective.planName,
      status: effective.status,
      currentPeriodEnd: subscription?.currentPeriodEnd?.toISOString() ?? null,
      entitlements: effective.entitlements,
      source: effective.source,
    }
  }

  async startCheckout(user: AuthUser, planId: string): Promise<{ checkoutUrl: string }> {
    const plan = await this.prisma.driverSubscriptionPlan.findFirst({
      where: { id: planId, lifecycleStatus: LifecycleStatus.ACTIVE, isPublic: true },
    })
    // 404 rather than 409, and one answer for all three of missing, archived and non-public:
    // a rider may only ever address a plan in their own catalog, so anything outside it must
    // be indistinguishable from a plan that does not exist. This is the same not-found
    // masking every other caller-named resource in this codebase uses.
    if (!plan) throw new SubscriptionPlanNotFoundError(planId)

    /**
     * A rider may hold exactly one live subscription. Without this check, buying the plan
     * they are already on opened a SECOND provider subscription for the same thing, and
     * applyCheckoutCompleted then overwrote providerSubscriptionId on their single row —
     * orphaning the first, which kept charging the same card with nothing naming it here.
     *
     * Only the same-plan case is refused. A DIFFERENT plan is a genuine upgrade or downgrade,
     * and the old provider subscription is cancelled when the new one activates — in
     * applyCheckoutCompleted, which is the first moment the rider has actually paid. Doing it
     * here would strip a rider of the plan they still hold the instant they opened a checkout
     * page they might abandon.
     */
    const live = await this.prisma.driverSubscription.findFirst({
      where: { userId: user.id, status: { in: [...LIVE_SUBSCRIPTION_STATUSES] } },
      select: { planId: true },
    })
    if (live?.planId === plan.id) throw new AlreadySubscribedToPlanError(plan.code)

    const providerCustomerId = await this.getOrCreateCustomer(user)

    const { checkoutUrl } = await this.billing.createCheckoutSession({
      providerCustomerId,
      subscriber: { type: 'driver', id: user.id },
      planId: plan.id,
      planCode: plan.code,
      priceCents: plan.priceCents,
      currency: plan.currency,
      interval: plan.interval,
      // Same deterministic shape the payment path uses for its provider calls. The time
      // bucket is what makes it deterministic without being permanent: a double-tapped
      // upgrade button replays the first hosted session instead of opening a second live
      // one, while a rider who abandons the page and comes back later still gets a fresh
      // session rather than a stale URL.
      idempotencyKey: this.checkoutIdempotencyKey(user.id, plan.id),
      // Fixed constants, never derived from the request body. A return URL the caller could
      // influence is an open redirect on the one page a rider reaches with a payment
      // credential still in hand.
      successUrl: CHECKOUT_SUCCESS_URL,
      cancelUrl: CHECKOUT_CANCEL_URL,
    })

    return { checkoutUrl }
  }

  private checkoutIdempotencyKey(userId: string, planId: string): string {
    const bucket = Math.floor(Date.now() / CHECKOUT_IDEMPOTENCY_WINDOW_MS)
    return `checkout_driver_${userId}_${planId}_${bucket}`
  }

  /**
   * The rider's provider identity, created once and reused for every later checkout — see
   * the DriverBillingCustomer model comment for why it is anchored to the user rather than
   * to a subscription that may not exist yet.
   */
  private async getOrCreateCustomer(user: AuthUser): Promise<string> {
    const provider = this.billing.providerName

    const existing = await this.prisma.driverBillingCustomer.findUnique({
      where: { userId: user.id },
    })
    if (existing && existing.provider === provider) return existing.providerCustomerId

    const { providerCustomerId } = await this.billing.getOrCreateCustomer({
      subscriber: { type: 'driver', id: user.id },
      email: user.email,
    })

    if (existing) {
      // The deployment changed providers under a rider who already had an identity at the
      // old one. Their `cus_mock_…` means nothing to Stripe, so the row is repointed rather
      // than trusted; the old customer stays at the old provider, where its history lives.
      this.logger.warn(
        `Driver ${user.id} had a ${existing.provider} billing customer; repointing to ${provider}`,
      )
      await this.prisma.driverBillingCustomer.update({
        where: { userId: user.id },
        data: { provider, providerCustomerId },
      })
      return providerCustomerId
    }

    try {
      await this.prisma.driverBillingCustomer.create({
        data: { userId: user.id, provider, providerCustomerId },
      })
    } catch (error) {
      // Two first-ever checkouts racing. The primary key on userId is what makes one of them
      // lose, and the loser re-reads rather than failing the rider: both provider calls
      // resolved to the same customer anyway (Stripe dedupes on a deterministic idempotency
      // key, the mock on the subscriber key), so the stored row is the right answer.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const row = await this.prisma.driverBillingCustomer.findUniqueOrThrow({
          where: { userId: user.id },
        })
        return row.providerCustomerId
      }
      throw error
    }

    return providerCustomerId
  }
}
