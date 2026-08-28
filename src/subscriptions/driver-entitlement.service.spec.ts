import { SubscriptionStatus } from '@prisma/client'
import type { PrismaService } from '../prisma/prisma.service'
import { DriverEntitlementService } from './driver-entitlement.service'
import {
  FREE_TIER_DRIVER_ENTITLEMENTS,
  type DriverEntitlements,
} from './driver-entitlements.schema'

const plus: DriverEntitlements = {
  bookingDiscountBps: 1_000,
  bookingFeeWaived: true,
  freeCancellations: 2,
  features: ['support.priority'],
}

describe('DriverEntitlementService', () => {
  let prisma: { driverSubscription: { findFirst: jest.Mock } }
  let service: DriverEntitlementService

  function onPlan(entitlements: DriverEntitlements, override: unknown = null) {
    prisma.driverSubscription.findFirst.mockResolvedValue({
      id: 'dsub1',
      status: SubscriptionStatus.ACTIVE,
      entitlementOverride: override,
      plan: { code: 'plus', name: 'Plus', entitlements },
    })
  }

  beforeEach(() => {
    prisma = { driverSubscription: { findFirst: jest.fn().mockResolvedValue(null) } }
    service = new DriverEntitlementService(prisma as unknown as PrismaService)
  })

  /**
   * The divergence from the operator side, asserted rather than assumed: no DriverSubscription
   * row is backfilled for the millions of existing User rows, so "no row" is the common case
   * and it must resolve without a second query and without an error.
   */
  describe('free tier', () => {
    it('resolves a rider with no subscription to the free tier', async () => {
      const effective = await service.resolveEffective('user1')

      expect(effective.entitlements).toEqual(FREE_TIER_DRIVER_ENTITLEMENTS)
      expect(effective.source).toBe('free')
      expect(effective.planCode).toBeNull()
      expect(effective.subscriptionId).toBeNull()
      expect(effective.status).toBeNull()
    })

    it('needs no catalog row to answer, so an empty catalog cannot wedge riders', async () => {
      await service.resolveEffective('user1')

      expect(prisma.driverSubscription.findFirst).toHaveBeenCalledTimes(1)
    })

    it('resolves a cancelled-only rider to the free tier', async () => {
      // The query filters on the live statuses, so a cancelled row is simply not returned.
      const effective = await service.resolveEffective('user1')

      expect(prisma.driverSubscription.findFirst.mock.calls[0]![0].where.status.in).toEqual([
        SubscriptionStatus.TRIALING,
        SubscriptionStatus.ACTIVE,
        SubscriptionStatus.PAST_DUE,
      ])
      expect(effective.source).toBe('free')
    })
  })

  describe('live subscription', () => {
    it("resolves to the plan's entitlements", async () => {
      onPlan(plus)

      const effective = await service.resolveEffective('user1')

      expect(effective.entitlements).toEqual(plus)
      expect(effective.source).toBe('subscription')
      expect(effective.planCode).toBe('plus')
      expect(effective.planName).toBe('Plus')
      expect(effective.subscriptionId).toBe('dsub1')
      expect(effective.status).toBe(SubscriptionStatus.ACTIVE)
    })

    // PAST_DUE is deliberately live: a failed charge starts dunning, it does not revoke a
    // paying rider's discount mid-cycle.
    it('still grants the plan while a charge is past due', async () => {
      prisma.driverSubscription.findFirst.mockResolvedValue({
        id: 'dsub1',
        status: SubscriptionStatus.PAST_DUE,
        entitlementOverride: null,
        plan: { code: 'plus', name: 'Plus', entitlements: plus },
      })

      const effective = await service.resolveEffective('user1')

      expect(effective.entitlements.bookingDiscountBps).toBe(1_000)
      expect(effective.status).toBe(SubscriptionStatus.PAST_DUE)
    })

    it('rejects a stored blob that no longer satisfies the schema', async () => {
      onPlan({ ...plus, bookingDiscountBps: 99_999 } as unknown as DriverEntitlements)

      await expect(service.resolveEffective('user1')).rejects.toThrow()
    })
  })

  describe('override merge', () => {
    it('lets the override win and reports the merged source', async () => {
      onPlan(plus, { bookingDiscountBps: 2_500 })

      const effective = await service.resolveEffective('user1')

      expect(effective.entitlements.bookingDiscountBps).toBe(2_500)
      expect(effective.source).toBe('subscription+override')
    })

    it('leaves keys the override does not name at the plan value', async () => {
      onPlan(plus, { bookingDiscountBps: 2_500 })

      const { entitlements } = await service.resolveEffective('user1')

      expect(entitlements.bookingFeeWaived).toBe(true)
      expect(entitlements.freeCancellations).toBe(2)
    })

    it('lets an override take a perk away', async () => {
      onPlan(plus, { features: [] })

      const { entitlements } = await service.resolveEffective('user1')

      expect(entitlements.features).toEqual([])
    })

    it('rejects an override with an unknown key rather than ignoring it', async () => {
      onPlan(plus, { bookingDiscount: 2_500 })

      await expect(service.resolveEffective('user1')).rejects.toThrow()
    })
  })

  describe('hasDriverFeature', () => {
    it('reports a feature the live plan grants', async () => {
      onPlan(plus)

      await expect(service.hasDriverFeature('user1', 'support.priority')).resolves.toBe(true)
    })

    it('reports false for a free-tier rider', async () => {
      await expect(service.hasDriverFeature('user1', 'support.priority')).resolves.toBe(false)
    })

    it('honours an override that removed the feature', async () => {
      onPlan(plus, { features: [] })

      await expect(service.hasDriverFeature('user1', 'support.priority')).resolves.toBe(false)
    })
  })
})
