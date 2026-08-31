import {
  InviteStatus,
  LifecycleStatus,
  OperatorInviteKind,
  SubscriptionStatus,
} from '@prisma/client'
import type { Entitlements } from '@spark/types'
import {
  DefaultSubscriptionPlanMissingError,
  EntitlementLimitExceededError,
  SubscriptionDowngradeBlockedError,
} from '../common/errors/domain.errors'
import { UNCLAIMED_OPERATOR_ID } from '../ingestion/ingestion.constants'
import type { PrismaService } from '../prisma/prisma.service'
import { EntitlementService } from './entitlement.service'

const starter: Entitlements = {
  maxFacilities: 1,
  maxTariffPlans: null,
  maxStaffSeats: null,
  features: [],
  commissionBps: 0,
}

describe('EntitlementService', () => {
  let prisma: {
    facility: { count: jest.Mock }
    tariffPlan: { count: jest.Mock }
    operatorMembership: { count: jest.Mock }
    operatorInvite: { count: jest.Mock }
    operatorSubscription: { findFirst: jest.Mock }
    subscriptionPlan: { findFirst: jest.Mock }
  }
  let service: EntitlementService

  function onPlan(entitlements: Entitlements, override: unknown = null) {
    prisma.operatorSubscription.findFirst.mockResolvedValue({
      id: 'sub1',
      status: SubscriptionStatus.ACTIVE,
      entitlementOverride: override,
      plan: { code: 'starter', name: 'Starter', entitlements },
    })
  }

  beforeEach(() => {
    prisma = {
      facility: { count: jest.fn().mockResolvedValue(0) },
      tariffPlan: { count: jest.fn().mockResolvedValue(0) },
      operatorMembership: { count: jest.fn().mockResolvedValue(0) },
      operatorInvite: { count: jest.fn().mockResolvedValue(0) },
      operatorSubscription: { findFirst: jest.fn().mockResolvedValue(null) },
      subscriptionPlan: {
        findFirst: jest.fn().mockResolvedValue({
          code: 'starter',
          name: 'Starter',
          entitlements: starter,
        }),
      },
    }
    service = new EntitlementService(prisma as unknown as PrismaService)
  })

  describe('quota counting predicate', () => {
    /**
     * The dropped Facility_operatorId_claimed_key counted
     * WHERE "operatorId" <> 'osm-unclaimed-operator' AND "lifecycleStatus" = 'ACTIVE'.
     * Counting anything else silently gives or takes a slot, so the predicate is asserted
     * literally rather than inferred from an outcome.
     */
    it('counts only lifecycle-ACTIVE facilities, naming the status explicitly', async () => {
      onPlan(starter)

      await service.assertCanCreateFacility('op1')

      expect(prisma.facility.count).toHaveBeenCalledWith({
        where: { operatorId: 'op1', lifecycleStatus: LifecycleStatus.ACTIVE },
      })
    })

    // Archived rows must not consume quota: archiving is the documented way to free a slot.
    it('lets an operator at the limit create again once a facility is archived', async () => {
      onPlan(starter)
      prisma.facility.count.mockResolvedValue(1)
      await expect(service.assertCanCreateFacility('op1')).rejects.toBeInstanceOf(
        EntitlementLimitExceededError,
      )

      prisma.facility.count.mockResolvedValue(0)
      await expect(service.assertCanCreateFacility('op1')).resolves.toBeUndefined()
    })

    it('counts only active, lifecycle-ACTIVE tariff plans', async () => {
      onPlan({ ...starter, maxTariffPlans: 3 })

      await service.assertCanCreateTariffPlan('op1')

      expect(prisma.tariffPlan.count).toHaveBeenCalledWith({
        where: { operatorId: 'op1', isActive: true, lifecycleStatus: LifecycleStatus.ACTIVE },
      })
    })

    it('counts staff seats as memberships plus live member invites', async () => {
      onPlan({ ...starter, maxStaffSeats: 5 })
      prisma.operatorMembership.count.mockResolvedValue(2)
      prisma.operatorInvite.count.mockResolvedValue(1)

      const usage = await service.usage('op1')

      expect(usage.staffSeats).toBe(3)
      expect(prisma.operatorInvite.count).toHaveBeenCalledWith({
        where: expect.objectContaining({
          operatorId: 'op1',
          kind: OperatorInviteKind.MEMBER,
          status: InviteStatus.PENDING,
        }),
      })
    })
  })

  describe('unclaimed-import operator', () => {
    it('is reported as quota exempt', () => {
      expect(service.isQuotaExempt(UNCLAIMED_OPERATOR_ID)).toBe(true)
      expect(service.isQuotaExempt('op1')).toBe(false)
    })

    // It holds ~1,500 ingested facilities. Exemption is checked before any subscription is
    // read, so an unconfigured catalog can never wedge the ingestion pipeline either.
    it('is admitted at any volume without reading a subscription', async () => {
      prisma.facility.count.mockResolvedValue(1_500)

      await expect(service.assertCanCreateFacility(UNCLAIMED_OPERATOR_ID)).resolves.toBeUndefined()
      expect(prisma.operatorSubscription.findFirst).not.toHaveBeenCalled()
      expect(prisma.facility.count).not.toHaveBeenCalled()
    })

    it('is exempt from the tariff and seat quotas too', async () => {
      await expect(
        service.assertCanCreateTariffPlan(UNCLAIMED_OPERATOR_ID),
      ).resolves.toBeUndefined()
      await expect(service.assertCanAddStaffSeat(UNCLAIMED_OPERATOR_ID)).resolves.toBeUndefined()
    })

    it('resolves to unlimited entitlements marked as exempt', async () => {
      const effective = await service.resolveEffective(UNCLAIMED_OPERATOR_ID)

      expect(effective.source).toBe('exempt')
      expect(effective.entitlements.maxFacilities).toBeNull()
      expect(effective.planCode).toBeNull()
    })
  })

  describe('resolution', () => {
    it('falls back to the default plan when no live subscription exists', async () => {
      const effective = await service.resolveEffective('op1')

      expect(effective.source).toBe('default')
      expect(effective.planCode).toBe('starter')
      expect(effective.subscriptionId).toBeNull()
    })

    it('fails closed when the default plan is missing or archived', async () => {
      prisma.subscriptionPlan.findFirst.mockResolvedValue(null)

      await expect(service.resolveEffective('op1')).rejects.toBeInstanceOf(
        DefaultSubscriptionPlanMissingError,
      )
    })

    it('uses the live subscription plan when there is one', async () => {
      onPlan({ ...starter, maxFacilities: 5 })

      const effective = await service.resolveEffective('op1')

      expect(effective.source).toBe('subscription')
      expect(effective.entitlements.maxFacilities).toBe(5)
    })

    it('lets a per-operator override beat the plan', async () => {
      onPlan(starter, { maxFacilities: 4 })

      const effective = await service.resolveEffective('op1')

      expect(effective.source).toBe('subscription+override')
      expect(effective.entitlements.maxFacilities).toBe(4)
    })

    it('admits a create the plan alone would refuse when an override raises the limit', async () => {
      onPlan(starter, { maxFacilities: 4 })
      prisma.facility.count.mockResolvedValue(1)

      await expect(service.assertCanCreateFacility('op1')).resolves.toBeUndefined()
    })

    it('treats null as unlimited and never counts', async () => {
      onPlan({ ...starter, maxFacilities: null })

      await expect(service.assertCanCreateFacility('op1')).resolves.toBeUndefined()
      expect(prisma.facility.count).not.toHaveBeenCalled()
    })

    it('treats 0 as a real limit that refuses everything', async () => {
      onPlan({ ...starter, maxFacilities: 0 })

      await expect(service.assertCanCreateFacility('op1')).rejects.toBeInstanceOf(
        EntitlementLimitExceededError,
      )
    })
  })

  describe('refusals', () => {
    it('names the limit and the number in use, in the right number', async () => {
      onPlan(starter)
      prisma.facility.count.mockResolvedValue(1)

      // Starter allows exactly one of most things, so the singular is the common case.
      await expect(service.assertCanCreateFacility('op1')).rejects.toThrow(
        /allows 1 facility and 1 is already in use/,
      )
    })

    it('uses plural forms when the numbers call for them', async () => {
      onPlan({ ...starter, maxFacilities: 5 })
      prisma.facility.count.mockResolvedValue(5)

      await expect(service.assertCanCreateFacility('op1')).rejects.toThrow(
        /allows 5 facilities and 5 are already in use/,
      )
    })

    it('refuses a downgrade below current usage, naming what to remove', async () => {
      prisma.facility.count.mockResolvedValue(3)

      const error = await service
        .assertUsageFitsEntitlements('op1', { ...starter, maxFacilities: 1 })
        .catch((e: unknown) => e)

      expect(error).toBeInstanceOf(SubscriptionDowngradeBlockedError)
      expect((error as SubscriptionDowngradeBlockedError).violations).toEqual([
        { resource: 'facilities', limit: 1, current: 3, remove: 2 },
      ])
      expect((error as Error).message).toContain('remove 2 first')
    })

    it('reports every breached limit, not just the first', async () => {
      prisma.facility.count.mockResolvedValue(3)
      prisma.tariffPlan.count.mockResolvedValue(7)
      prisma.operatorMembership.count.mockResolvedValue(9)

      const error = await service
        .assertUsageFitsEntitlements('op1', {
          ...starter,
          maxFacilities: 1,
          maxTariffPlans: 2,
          maxStaffSeats: 4,
        })
        .catch((e: unknown) => e)

      expect(
        (error as SubscriptionDowngradeBlockedError).violations.map((v) => v.resource),
      ).toEqual(['facilities', 'tariff plans', 'staff seats'])
    })

    it('admits a plan change that exactly matches current usage', async () => {
      prisma.facility.count.mockResolvedValue(1)

      await expect(
        service.assertUsageFitsEntitlements('op1', { ...starter, maxFacilities: 1 }),
      ).resolves.toBeUndefined()
    })

    it('never applies the downgrade guard to the exempt operator', async () => {
      prisma.facility.count.mockResolvedValue(1_500)

      await expect(
        service.assertUsageFitsEntitlements(UNCLAIMED_OPERATOR_ID, {
          ...starter,
          maxFacilities: 1,
        }),
      ).resolves.toBeUndefined()
    })
  })
})
