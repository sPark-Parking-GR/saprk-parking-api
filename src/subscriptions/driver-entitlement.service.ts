import { Injectable } from '@nestjs/common'
import type { Prisma, SubscriptionStatus } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import {
  driverEntitlementOverrideSchema,
  driverEntitlementsSchema,
  mergeDriverEntitlements,
  FREE_TIER_DRIVER_ENTITLEMENTS,
  type DriverEntitlements,
  type DriverSubscriptionFeature,
} from './driver-entitlements.schema'
import { LIVE_SUBSCRIPTION_STATUSES } from './subscriptions.constants'

export type DriverEntitlementSource = 'free' | 'subscription' | 'subscription+override'

export interface EffectiveDriverEntitlements {
  userId: string
  entitlements: DriverEntitlements
  source: DriverEntitlementSource
  planCode: string | null
  planName: string | null
  subscriptionId: string | null
  status: SubscriptionStatus | null
}

/**
 * Resolves what perks a rider has bought. The counterpart of EntitlementService, minus its
 * quota machinery: driver entitlements grant discounts and waivers applied at booking-price
 * capture, not caps on countable resources, so there is nothing to count and nothing to
 * assert against.
 *
 * NO DEFAULT-PLAN LOOKUP, AND NO FAIL-CLOSED ERROR. The operator side must find a `starter`
 * row for an operator with no live subscription, and raises DefaultSubscriptionPlanMissingError
 * when it cannot, because guessing there means either blocking every tenant or selling the
 * platform away. Here the absence of a subscription has one honest meaning — the rider is on
 * the free tier and gets no perks — and FREE_TIER_DRIVER_ENTITLEMENTS says exactly that
 * without a database round trip. That is what lets millions of User rows exist with no
 * DriverSubscription row at all (see the model comment in schema.prisma).
 */
@Injectable()
export class DriverEntitlementService {
  constructor(private readonly prisma: PrismaService) {}

  async resolveEffective(
    userId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<EffectiveDriverEntitlements> {
    const client = tx ?? this.prisma

    const subscription = await client.driverSubscription.findFirst({
      where: { userId, status: { in: [...LIVE_SUBSCRIPTION_STATUSES] } },
      include: { plan: true },
    })

    if (!subscription) {
      return {
        userId,
        entitlements: FREE_TIER_DRIVER_ENTITLEMENTS,
        source: 'free',
        planCode: null,
        planName: null,
        subscriptionId: null,
        status: null,
      }
    }

    const base = driverEntitlementsSchema.parse(subscription.plan.entitlements)
    const override =
      subscription.entitlementOverride === null
        ? null
        : driverEntitlementOverrideSchema.parse(subscription.entitlementOverride)

    return {
      userId,
      entitlements: override ? mergeDriverEntitlements(base, override) : base,
      source: override ? 'subscription+override' : 'subscription',
      planCode: subscription.plan.code,
      planName: subscription.plan.name,
      subscriptionId: subscription.id,
      status: subscription.status,
    }
  }

  /**
   * Whether the rider's plan includes a capability at all. Distinct from the numeric perks
   * for the same reason as on the operator side: "your plan does not include this" and
   * "your plan grants none of these" are different things to tell a paying customer.
   */
  async hasDriverFeature(
    userId: string,
    feature: DriverSubscriptionFeature,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    const { entitlements } = await this.resolveEffective(userId, tx)
    return entitlements.features.includes(feature)
  }
}
