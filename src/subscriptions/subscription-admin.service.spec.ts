import { ForbiddenException } from '@nestjs/common'
import { BillingInterval, LifecycleStatus, SubscriptionStatus } from '@prisma/client'
import type { AuthUser } from '@spark/types'
import {
  SubscriptionDowngradeBlockedError,
  SubscriptionPlanInUseError,
  SubscriptionPlanNotFoundError,
} from '../common/errors/domain.errors'
import type { PrismaService } from '../prisma/prisma.service'
import type { EntitlementService } from './entitlement.service'
import type { Entitlements } from './entitlements.schema'
import { SubscriptionAdminService } from './subscription-admin.service'

const starter: Entitlements = {
  maxFacilities: 1,
  maxTariffPlans: null,
  maxStaffSeats: null,
  features: [],
  commissionBps: 0,
}

const platformAdmin: AuthUser = {
  id: 'admin1',
  email: 'admin@spark.test',
  role: 'platform_admin',
  emailVerified: true,
}

const operatorAdmin: AuthUser = { ...platformAdmin, id: 'op-admin', role: 'operator_admin' }
const operatorStaff: AuthUser = { ...platformAdmin, id: 'staff', role: 'operator_staff' }
const consumer: AuthUser = { ...platformAdmin, id: 'user', role: 'user' }

function planRow(over: Record<string, unknown> = {}) {
  return {
    id: 'plan_growth',
    code: 'growth',
    name: 'Growth',
    description: null,
    priceCents: 4_900,
    currency: 'EUR',
    interval: BillingInterval.MONTHLY,
    entitlements: { ...starter, maxFacilities: 5 },
    isPublic: true,
    sortOrder: 1,
    lifecycleStatus: LifecycleStatus.ACTIVE,
    ...over,
  }
}

describe('SubscriptionAdminService', () => {
  let prisma: {
    subscriptionPlan: {
      findFirst: jest.Mock
      findMany: jest.Mock
      create: jest.Mock
      update: jest.Mock
    }
    operatorSubscription: {
      findFirst: jest.Mock
      findMany: jest.Mock
      create: jest.Mock
      update: jest.Mock
      count: jest.Mock
    }
    auditLog: { create: jest.Mock }
    $transaction: jest.Mock
    $executeRaw: jest.Mock
  }
  let entitlements: {
    describe: jest.Mock
    assertUsageFitsEntitlements: jest.Mock
  }
  let service: SubscriptionAdminService
  let tx: typeof prisma

  beforeEach(() => {
    prisma = {
      subscriptionPlan: {
        findFirst: jest.fn().mockResolvedValue(planRow()),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue(planRow()),
        update: jest.fn().mockResolvedValue(planRow()),
      },
      operatorSubscription: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        update: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
      },
      auditLog: { create: jest.fn() },
      $transaction: jest.fn(),
      $executeRaw: jest.fn().mockResolvedValue(0),
    }
    tx = prisma
    prisma.$transaction.mockImplementation(async (cb: (t: typeof tx) => unknown) => cb(tx))

    entitlements = {
      describe: jest.fn().mockResolvedValue({
        operatorId: 'op1',
        entitlements: starter,
        source: 'default',
        planCode: 'starter',
        planName: 'Starter',
        subscriptionId: null,
        status: null,
        usage: { facilities: 0, tariffPlans: 0, staffSeats: 0 },
      }),
      assertUsageFitsEntitlements: jest.fn().mockResolvedValue(undefined),
    }

    service = new SubscriptionAdminService(
      prisma as unknown as PrismaService,
      entitlements as unknown as EntitlementService,
    )
  })

  /**
   * The controller carries @RequirePermission('platform:billing.manage'); this is the
   * second layer the project's authorization rule requires, so the service refuses on its
   * own even if it is ever reached from somewhere that is not the guarded route.
   */
  describe('service-layer authorization', () => {
    it.each([
      ['operator_admin', operatorAdmin],
      ['operator_staff', operatorStaff],
      ['user', consumer],
    ])('refuses %s on every entry point', async (_label, actor) => {
      await expect(service.listPlans(actor, { includeArchived: false })).rejects.toBeInstanceOf(
        ForbiddenException,
      )
      await expect(service.getOperatorSubscription(actor, 'op1')).rejects.toBeInstanceOf(
        ForbiddenException,
      )
      await expect(
        service.assignSubscription(actor, 'op1', {
          planId: 'plan_growth',
          status: SubscriptionStatus.ACTIVE,
          cancelAtPeriodEnd: false,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException)
      await expect(
        service.setOverride(actor, 'op1', { entitlementOverride: null }),
      ).rejects.toBeInstanceOf(ForbiddenException)
      await expect(service.archivePlan(actor, 'plan_growth', {})).rejects.toBeInstanceOf(
        ForbiddenException,
      )
    })

    it('refuses before touching the database', async () => {
      await expect(
        service.assignSubscription(operatorAdmin, 'op1', {
          planId: 'plan_growth',
          status: SubscriptionStatus.ACTIVE,
          cancelAtPeriodEnd: false,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException)
      expect(prisma.$transaction).not.toHaveBeenCalled()
    })

    it('admits a platform administrator', async () => {
      await expect(service.listPlans(platformAdmin, { includeArchived: false })).resolves.toEqual(
        [],
      )
    })
  })

  describe('assignSubscription', () => {
    it('locks the operator row before checking usage', async () => {
      await service.assignSubscription(platformAdmin, 'op1', {
        planId: 'plan_growth',
        status: SubscriptionStatus.ACTIVE,
        cancelAtPeriodEnd: false,
      })

      const lockOrder = prisma.$executeRaw.mock.invocationCallOrder[0]!
      const checkOrder = entitlements.assertUsageFitsEntitlements.mock.invocationCallOrder[0]!
      expect(lockOrder).toBeLessThan(checkOrder)
    })

    it('propagates the downgrade refusal and writes nothing', async () => {
      entitlements.assertUsageFitsEntitlements.mockRejectedValue(
        new SubscriptionDowngradeBlockedError([
          { resource: 'facilities', limit: 1, current: 3, remove: 2 },
        ]),
      )

      await expect(
        service.assignSubscription(platformAdmin, 'op1', {
          planId: 'plan_growth',
          status: SubscriptionStatus.ACTIVE,
          cancelAtPeriodEnd: false,
        }),
      ).rejects.toBeInstanceOf(SubscriptionDowngradeBlockedError)

      expect(prisma.operatorSubscription.create).not.toHaveBeenCalled()
      expect(prisma.operatorSubscription.update).not.toHaveBeenCalled()
    })

    it('creates a subscription when the operator has none', async () => {
      await service.assignSubscription(platformAdmin, 'op1', {
        planId: 'plan_growth',
        status: SubscriptionStatus.ACTIVE,
        cancelAtPeriodEnd: false,
      })

      expect(prisma.operatorSubscription.create).toHaveBeenCalled()
      expect(prisma.operatorSubscription.create.mock.calls[0]![0].data.operatorId).toBe('op1')
    })

    it('updates the live subscription in place rather than creating a second one', async () => {
      prisma.operatorSubscription.findFirst.mockResolvedValue({
        id: 'sub1',
        planId: 'plan_starter',
        status: SubscriptionStatus.ACTIVE,
        entitlementOverride: null,
      })

      await service.assignSubscription(platformAdmin, 'op1', {
        planId: 'plan_growth',
        status: SubscriptionStatus.ACTIVE,
        cancelAtPeriodEnd: false,
      })

      expect(prisma.operatorSubscription.update).toHaveBeenCalled()
      expect(prisma.operatorSubscription.create).not.toHaveBeenCalled()
    })

    // A deal nobody meant to revoke must survive a plan change.
    it('preserves an existing override when the request does not mention one', async () => {
      prisma.operatorSubscription.findFirst.mockResolvedValue({
        id: 'sub1',
        planId: 'plan_starter',
        status: SubscriptionStatus.ACTIVE,
        entitlementOverride: { maxFacilities: 4 },
      })

      await service.assignSubscription(platformAdmin, 'op1', {
        planId: 'plan_growth',
        status: SubscriptionStatus.ACTIVE,
        cancelAtPeriodEnd: false,
      })

      expect(entitlements.assertUsageFitsEntitlements.mock.calls[0]![1].maxFacilities).toBe(4)
    })

    it('checks usage against plan+override, not the plan alone', async () => {
      await service.assignSubscription(platformAdmin, 'op1', {
        planId: 'plan_growth',
        status: SubscriptionStatus.ACTIVE,
        cancelAtPeriodEnd: false,
        entitlementOverride: { maxFacilities: 2 },
      })

      expect(entitlements.assertUsageFitsEntitlements.mock.calls[0]![1].maxFacilities).toBe(2)
    })

    // Cancelling drops the operator to the default plan, so it is a downgrade too.
    it('checks a cancellation against the default plan the operator falls back to', async () => {
      prisma.subscriptionPlan.findFirst.mockImplementation(
        ({ where }: { where: { code?: string } }) =>
          where.code === 'starter'
            ? Promise.resolve({ entitlements: starter })
            : Promise.resolve(planRow()),
      )

      await service.assignSubscription(platformAdmin, 'op1', {
        planId: 'plan_growth',
        status: SubscriptionStatus.CANCELLED,
        cancelAtPeriodEnd: false,
      })

      expect(entitlements.assertUsageFitsEntitlements.mock.calls[0]![1].maxFacilities).toBe(1)
    })

    it('rejects an unknown or archived plan', async () => {
      prisma.subscriptionPlan.findFirst.mockResolvedValue(null)

      await expect(
        service.assignSubscription(platformAdmin, 'op1', {
          planId: 'nope',
          status: SubscriptionStatus.ACTIVE,
          cancelAtPeriodEnd: false,
        }),
      ).rejects.toBeInstanceOf(SubscriptionPlanNotFoundError)
    })
  })

  describe('setOverride', () => {
    it('applies the same downgrade guard as a plan change', async () => {
      prisma.operatorSubscription.findFirst.mockResolvedValue({
        id: 'sub1',
        planId: 'plan_growth',
        status: SubscriptionStatus.ACTIVE,
        entitlementOverride: null,
      })
      entitlements.assertUsageFitsEntitlements.mockRejectedValue(
        new SubscriptionDowngradeBlockedError([
          { resource: 'facilities', limit: 1, current: 3, remove: 2 },
        ]),
      )

      await expect(
        service.setOverride(platformAdmin, 'op1', { entitlementOverride: { maxFacilities: 1 } }),
      ).rejects.toBeInstanceOf(SubscriptionDowngradeBlockedError)
      expect(prisma.operatorSubscription.update).not.toHaveBeenCalled()
    })
  })

  describe('archivePlan', () => {
    it('refuses to archive a plan with live subscribers', async () => {
      prisma.operatorSubscription.count.mockResolvedValue(3)

      await expect(service.archivePlan(platformAdmin, 'plan_growth', {})).rejects.toBeInstanceOf(
        SubscriptionPlanInUseError,
      )
      expect(prisma.subscriptionPlan.update).not.toHaveBeenCalled()
    })

    // Everything without a live subscription resolves to it.
    it('refuses to archive the default plan', async () => {
      prisma.subscriptionPlan.findFirst.mockResolvedValue(planRow({ code: 'starter' }))

      await expect(service.archivePlan(platformAdmin, 'plan_starter', {})).rejects.toBeInstanceOf(
        SubscriptionPlanInUseError,
      )
    })

    it('archives rather than deletes an unused plan', async () => {
      await service.archivePlan(platformAdmin, 'plan_growth', { reason: 'retired' })

      const data = prisma.subscriptionPlan.update.mock.calls[0]![0].data
      expect(data.lifecycleStatus).toBe(LifecycleStatus.ARCHIVED)
      expect(data.lifecycleChangedBy).toBe('admin1')
      expect(data.lifecycleReason).toBe('retired')
    })
  })

  describe('updatePlan', () => {
    it('re-validates every live subscriber before lowering a shared limit', async () => {
      prisma.operatorSubscription.findMany.mockResolvedValue([
        { operatorId: 'opA', entitlementOverride: null },
        { operatorId: 'opB', entitlementOverride: null },
      ])

      await service.updatePlan(platformAdmin, 'plan_growth', {
        entitlements: { ...starter, maxFacilities: 2 },
      })

      expect(entitlements.assertUsageFitsEntitlements).toHaveBeenCalledTimes(2)
      expect(entitlements.assertUsageFitsEntitlements.mock.calls.map((c) => c[0])).toEqual([
        'opA',
        'opB',
      ])
    })

    it('does not re-validate subscribers when entitlements are untouched', async () => {
      await service.updatePlan(platformAdmin, 'plan_growth', { name: 'Growth Plus' })

      expect(entitlements.assertUsageFitsEntitlements).not.toHaveBeenCalled()
    })
  })
})
