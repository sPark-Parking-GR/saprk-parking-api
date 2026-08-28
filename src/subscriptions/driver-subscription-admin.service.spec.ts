import { ForbiddenException } from '@nestjs/common'
import { BillingInterval, LifecycleStatus, SubscriptionStatus } from '@prisma/client'
import type { AuthUser } from '@spark/types'
import {
  LiveSubscriptionNotFoundError,
  SubscriptionPlanInUseError,
  SubscriptionPlanNotFoundError,
} from '../common/errors/domain.errors'
import type { PrismaService } from '../prisma/prisma.service'
import type { SubscriptionBillingService } from '../subscription-billing/subscription-billing.service'
import type { DriverEntitlementService } from './driver-entitlement.service'
import {
  FREE_TIER_DRIVER_ENTITLEMENTS,
  type DriverEntitlements,
} from './driver-entitlements.schema'
import { DriverSubscriptionAdminService } from './driver-subscription-admin.service'

const plus: DriverEntitlements = {
  bookingDiscountBps: 1_000,
  bookingFeeWaived: true,
  freeCancellations: 2,
  features: ['support.priority'],
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
    id: 'dplan_plus',
    code: 'plus',
    name: 'Plus',
    description: null,
    priceCents: 499,
    currency: 'EUR',
    interval: BillingInterval.MONTHLY,
    entitlements: plus,
    isPublic: true,
    sortOrder: 1,
    lifecycleStatus: LifecycleStatus.ACTIVE,
    ...over,
  }
}

describe('DriverSubscriptionAdminService', () => {
  let prisma: {
    driverSubscriptionPlan: {
      findFirst: jest.Mock
      findMany: jest.Mock
      create: jest.Mock
      update: jest.Mock
    }
    driverSubscription: {
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
  let entitlements: { resolveEffective: jest.Mock }
  let billing: { providerName: string; cancelSubscriptionBestEffort: jest.Mock }
  let service: DriverSubscriptionAdminService
  let tx: typeof prisma

  beforeEach(() => {
    prisma = {
      driverSubscriptionPlan: {
        findFirst: jest.fn().mockResolvedValue(planRow()),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue(planRow()),
        update: jest.fn().mockResolvedValue(planRow()),
      },
      driverSubscription: {
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
      resolveEffective: jest.fn().mockResolvedValue({
        userId: 'user1',
        entitlements: FREE_TIER_DRIVER_ENTITLEMENTS,
        source: 'free',
        planCode: null,
        planName: null,
        subscriptionId: null,
        status: null,
      }),
    }

    billing = {
      providerName: 'stripe',
      cancelSubscriptionBestEffort: jest.fn().mockResolvedValue(true),
    }

    service = new DriverSubscriptionAdminService(
      prisma as unknown as PrismaService,
      entitlements as unknown as DriverEntitlementService,
      billing as unknown as SubscriptionBillingService,
    )
  })

  /**
   * The controller carries @RequirePermission('platform:billing.manage'); this is the second
   * layer the project's authorization rule requires, so the service refuses on its own even
   * if it is ever reached from somewhere that is not the guarded route.
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
      await expect(
        service.createPlan(actor, {
          code: 'plus',
          name: 'Plus',
          priceCents: 499,
          currency: 'EUR',
          interval: BillingInterval.MONTHLY,
          entitlements: plus,
          isPublic: true,
          sortOrder: 0,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException)
      await expect(service.updatePlan(actor, 'dplan_plus', {})).rejects.toBeInstanceOf(
        ForbiddenException,
      )
      await expect(service.archivePlan(actor, 'dplan_plus', {})).rejects.toBeInstanceOf(
        ForbiddenException,
      )
      await expect(service.getDriverSubscription(actor, 'user1')).rejects.toBeInstanceOf(
        ForbiddenException,
      )
      await expect(
        service.assignSubscription(actor, 'user1', {
          planId: 'dplan_plus',
          status: SubscriptionStatus.ACTIVE,
          cancelAtPeriodEnd: false,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException)
      await expect(
        service.setOverride(actor, 'user1', { entitlementOverride: null }),
      ).rejects.toBeInstanceOf(ForbiddenException)
    })

    it('refuses before touching the database', async () => {
      await expect(
        service.assignSubscription(operatorAdmin, 'user1', {
          planId: 'dplan_plus',
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

  describe('createPlan', () => {
    it('normalizes the entitlements before storing them', async () => {
      await service.createPlan(platformAdmin, {
        code: 'plus',
        name: 'Plus',
        priceCents: 499,
        currency: 'EUR',
        interval: BillingInterval.MONTHLY,
        entitlements: { ...plus, features: ['support.priority', 'support.priority'] },
        isPublic: true,
        sortOrder: 0,
      })

      expect(prisma.driverSubscriptionPlan.create.mock.calls[0]![0].data.entitlements.features)
        .toEqual(['support.priority'])
    })

    it('writes an audit row naming the plan', async () => {
      await service.createPlan(platformAdmin, {
        code: 'plus',
        name: 'Plus',
        priceCents: 499,
        currency: 'EUR',
        interval: BillingInterval.MONTHLY,
        entitlements: plus,
        isPublic: true,
        sortOrder: 0,
      })

      const data = prisma.auditLog.create.mock.calls[0]![0].data
      expect(data.action).toBe('driver_subscription_plan.created')
      expect(data.entityType).toBe('DriverSubscriptionPlan')
      expect(data.actorId).toBe('admin1')
    })

    it('lists only active plans unless archived ones are asked for', async () => {
      await service.listPlans(platformAdmin, { includeArchived: false })
      expect(prisma.driverSubscriptionPlan.findMany.mock.calls[0]![0].where).toEqual({
        lifecycleStatus: LifecycleStatus.ACTIVE,
      })

      await service.listPlans(platformAdmin, { includeArchived: true })
      expect(prisma.driverSubscriptionPlan.findMany.mock.calls[1]![0].where).toEqual({})
    })
  })

  describe('updatePlan', () => {
    it('rejects an unknown or archived plan', async () => {
      prisma.driverSubscriptionPlan.findFirst.mockResolvedValue(null)

      await expect(service.updatePlan(platformAdmin, 'nope', {})).rejects.toBeInstanceOf(
        SubscriptionPlanNotFoundError,
      )
    })

    it('writes only the fields the request named', async () => {
      await service.updatePlan(platformAdmin, 'dplan_plus', { name: 'Plus Annual' })

      expect(prisma.driverSubscriptionPlan.update.mock.calls[0]![0].data).toEqual({
        name: 'Plus Annual',
      })
    })

    it('normalizes replacement entitlements', async () => {
      await service.updatePlan(platformAdmin, 'dplan_plus', {
        entitlements: { ...plus, features: ['support.priority', 'support.priority'] },
      })

      expect(
        prisma.driverSubscriptionPlan.update.mock.calls[0]![0].data.entitlements.features,
      ).toEqual(['support.priority'])
    })

    /**
     * The counterpart of SubscriptionAdminService.updatePlan's per-subscriber re-validation
     * loop, which has no driver equivalent yet because no driver entitlement caps a
     * countable resource. Asserted so that adding one without the guard fails here rather
     * than stranding riders over a limit nothing then refuses.
     */
    it('does not read subscribers, because nothing on a driver plan is a countable quota', async () => {
      await service.updatePlan(platformAdmin, 'dplan_plus', {
        entitlements: { ...plus, bookingDiscountBps: 0 },
      })

      expect(prisma.driverSubscription.findMany).not.toHaveBeenCalled()
    })

    it('writes an audit row', async () => {
      await service.updatePlan(platformAdmin, 'dplan_plus', { name: 'Plus Annual' })

      expect(prisma.auditLog.create.mock.calls[0]![0].data.action).toBe(
        'driver_subscription_plan.updated',
      )
    })
  })

  describe('archivePlan', () => {
    it('refuses to archive a plan with live subscribers', async () => {
      prisma.driverSubscription.count.mockResolvedValue(3)

      await expect(service.archivePlan(platformAdmin, 'dplan_plus', {})).rejects.toBeInstanceOf(
        SubscriptionPlanInUseError,
      )
      expect(prisma.driverSubscriptionPlan.update).not.toHaveBeenCalled()
    })

    it('archives rather than deletes an unused plan', async () => {
      await service.archivePlan(platformAdmin, 'dplan_plus', { reason: 'retired' })

      const data = prisma.driverSubscriptionPlan.update.mock.calls[0]![0].data
      expect(data.lifecycleStatus).toBe(LifecycleStatus.ARCHIVED)
      expect(data.lifecycleChangedBy).toBe('admin1')
      expect(data.lifecycleReason).toBe('retired')
    })

    /**
     * The operator side refuses to archive `starter` because every unsubscribed operator
     * resolves to it. No driver plan is load-bearing that way — the free tier lives in code
     * — so any unused plan may go.
     */
    it('has no undeletable default plan', async () => {
      prisma.driverSubscriptionPlan.findFirst.mockResolvedValue(planRow({ code: 'starter' }))

      await expect(service.archivePlan(platformAdmin, 'dplan_plus', {})).resolves.toBeDefined()
    })

    it('writes an audit row', async () => {
      await service.archivePlan(platformAdmin, 'dplan_plus', {})

      expect(prisma.auditLog.create.mock.calls[0]![0].data.action).toBe(
        'driver_subscription_plan.archived',
      )
    })
  })

  describe('assignSubscription', () => {
    it('locks the user row before writing', async () => {
      await service.assignSubscription(platformAdmin, 'user1', {
        planId: 'dplan_plus',
        status: SubscriptionStatus.ACTIVE,
        cancelAtPeriodEnd: false,
      })

      const lockOrder = prisma.$executeRaw.mock.invocationCallOrder[0]!
      const writeOrder = prisma.driverSubscription.create.mock.invocationCallOrder[0]!
      expect(lockOrder).toBeLessThan(writeOrder)
    })

    it('creates a subscription when the rider has none', async () => {
      await service.assignSubscription(platformAdmin, 'user1', {
        planId: 'dplan_plus',
        status: SubscriptionStatus.ACTIVE,
        cancelAtPeriodEnd: false,
      })

      expect(prisma.driverSubscription.create.mock.calls[0]![0].data.userId).toBe('user1')
      expect(prisma.driverSubscription.update).not.toHaveBeenCalled()
    })

    it('updates the live subscription in place rather than creating a second one', async () => {
      prisma.driverSubscription.findFirst.mockResolvedValue({
        id: 'dsub1',
        planId: 'dplan_basic',
        status: SubscriptionStatus.ACTIVE,
        entitlementOverride: null,
      })

      await service.assignSubscription(platformAdmin, 'user1', {
        planId: 'dplan_plus',
        status: SubscriptionStatus.ACTIVE,
        cancelAtPeriodEnd: false,
      })

      expect(prisma.driverSubscription.update).toHaveBeenCalled()
      expect(prisma.driverSubscription.create).not.toHaveBeenCalled()
    })

    // A deal nobody meant to revoke must survive a plan change.
    it('preserves an existing override when the request does not mention one', async () => {
      prisma.driverSubscription.findFirst.mockResolvedValue({
        id: 'dsub1',
        planId: 'dplan_basic',
        status: SubscriptionStatus.ACTIVE,
        entitlementOverride: { bookingDiscountBps: 2_500 },
      })

      await service.assignSubscription(platformAdmin, 'user1', {
        planId: 'dplan_plus',
        status: SubscriptionStatus.ACTIVE,
        cancelAtPeriodEnd: false,
      })

      expect(prisma.driverSubscription.update.mock.calls[0]![0].data.entitlementOverride).toEqual({
        bookingDiscountBps: 2_500,
      })
    })

    it('stamps cancelledAt when the assignment is terminal', async () => {
      await service.assignSubscription(platformAdmin, 'user1', {
        planId: 'dplan_plus',
        status: SubscriptionStatus.CANCELLED,
        cancelAtPeriodEnd: false,
      })

      expect(prisma.driverSubscription.create.mock.calls[0]![0].data.cancelledAt).toBeInstanceOf(
        Date,
      )
    })

    /**
     * HIGH 2. Setting the row to CANCELLED and stopping there is not a cancellation: the
     * provider goes on charging the rider's card on its own schedule, and nothing in this
     * database points at the subscription doing it.
     */
    it('cancels the subscription at the billing provider when an admin cancels it', async () => {
      prisma.driverSubscription.findFirst.mockResolvedValue({
        id: 'dsub1',
        planId: 'dplan_plus',
        status: SubscriptionStatus.ACTIVE,
        providerSubscriptionId: 'sub_live',
        entitlementOverride: null,
      })

      await service.assignSubscription(platformAdmin, 'user1', {
        planId: 'dplan_plus',
        status: SubscriptionStatus.CANCELLED,
        cancelAtPeriodEnd: false,
      })

      expect(billing.cancelSubscriptionBestEffort).toHaveBeenCalledWith(
        'sub_live',
        expect.objectContaining({ reason: 'admin_assign', userId: 'user1' }),
      )
    })

    // Moving a rider onto another plan REPLACES the agreement. Leaving the old provider
    // subscription live would bill them for both at once.
    it('cancels the old provider subscription when an admin moves the rider to another plan', async () => {
      prisma.driverSubscription.findFirst.mockResolvedValue({
        id: 'dsub1',
        planId: 'dplan_basic',
        status: SubscriptionStatus.ACTIVE,
        providerSubscriptionId: 'sub_live',
        entitlementOverride: null,
      })

      await service.assignSubscription(platformAdmin, 'user1', {
        planId: 'dplan_plus',
        status: SubscriptionStatus.ACTIVE,
        cancelAtPeriodEnd: false,
      })

      expect(billing.cancelSubscriptionBestEffort).toHaveBeenCalledWith(
        'sub_live',
        expect.anything(),
      )
      // Retired as its own CANCELLED row, keeping the provider id, so the subscription.deleted
      // our cancellation provokes lands there and not on the plan just granted.
      expect(prisma.driverSubscription.update.mock.calls[0]![0].data).toMatchObject({
        status: SubscriptionStatus.CANCELLED,
      })
      expect(prisma.driverSubscription.create.mock.calls[0]![0].data.planId).toBe('dplan_plus')
    })

    // A status edit on the plan the rider already holds is an adjustment, not a replacement.
    it('leaves the provider alone when only the status of the same plan changes', async () => {
      prisma.driverSubscription.findFirst.mockResolvedValue({
        id: 'dsub1',
        planId: 'dplan_plus',
        status: SubscriptionStatus.ACTIVE,
        providerSubscriptionId: 'sub_live',
        entitlementOverride: null,
      })

      await service.assignSubscription(platformAdmin, 'user1', {
        planId: 'dplan_plus',
        status: SubscriptionStatus.PAST_DUE,
        cancelAtPeriodEnd: false,
      })

      expect(billing.cancelSubscriptionBestEffort).not.toHaveBeenCalled()
    })

    // Nothing to cancel: an administrator's manual grant was never billed by the provider.
    it('calls the provider only for a subscription the provider actually bills', async () => {
      prisma.driverSubscription.findFirst.mockResolvedValue({
        id: 'dsub1',
        planId: 'dplan_basic',
        status: SubscriptionStatus.ACTIVE,
        providerSubscriptionId: null,
        entitlementOverride: null,
      })

      await service.assignSubscription(platformAdmin, 'user1', {
        planId: 'dplan_plus',
        status: SubscriptionStatus.CANCELLED,
        cancelAtPeriodEnd: false,
      })

      expect(billing.cancelSubscriptionBestEffort).not.toHaveBeenCalled()
    })

    /**
     * Best-effort, mirroring NotificationsService.safeSend: a transient Stripe outage must not
     * block an administrator's override. But it must not be silent either — the audit row is
     * what a billing reconciliation reads when the provider is still charging someone this
     * database says is cancelled.
     */
    it('completes the local write and records the discrepancy when the provider call fails', async () => {
      billing.cancelSubscriptionBestEffort.mockResolvedValue(false)
      prisma.driverSubscription.findFirst.mockResolvedValue({
        id: 'dsub1',
        planId: 'dplan_plus',
        status: SubscriptionStatus.ACTIVE,
        providerSubscriptionId: 'sub_live',
        entitlementOverride: null,
      })

      await service.assignSubscription(platformAdmin, 'user1', {
        planId: 'dplan_plus',
        status: SubscriptionStatus.CANCELLED,
        cancelAtPeriodEnd: false,
      })

      expect(prisma.driverSubscription.update).toHaveBeenCalled()
      expect(
        prisma.auditLog.create.mock.calls.map((call) => call[0].data.action),
      ).toContain('driver_subscription.provider_cancel_failed')
    })

    it('rejects an unknown or archived plan', async () => {
      prisma.driverSubscriptionPlan.findFirst.mockResolvedValue(null)

      await expect(
        service.assignSubscription(platformAdmin, 'user1', {
          planId: 'nope',
          status: SubscriptionStatus.ACTIVE,
          cancelAtPeriodEnd: false,
        }),
      ).rejects.toBeInstanceOf(SubscriptionPlanNotFoundError)
      expect(prisma.driverSubscription.create).not.toHaveBeenCalled()
    })

    it('rejects an override with an unknown key rather than storing it', async () => {
      await expect(
        service.assignSubscription(platformAdmin, 'user1', {
          planId: 'dplan_plus',
          status: SubscriptionStatus.ACTIVE,
          cancelAtPeriodEnd: false,
          entitlementOverride: { bookingDiscount: 10 } as never,
        }),
      ).rejects.toThrow()
      expect(prisma.driverSubscription.create).not.toHaveBeenCalled()
    })

    it('writes an audit row naming the plan and status', async () => {
      await service.assignSubscription(platformAdmin, 'user1', {
        planId: 'dplan_plus',
        status: SubscriptionStatus.ACTIVE,
        cancelAtPeriodEnd: false,
      })

      const data = prisma.auditLog.create.mock.calls[0]![0].data
      expect(data.action).toBe('driver_subscription.assigned')
      expect(data.entityType).toBe('DriverSubscription')
      expect(data.entityId).toBe('user1')
      expect(data.payload).toMatchObject({ planCode: 'plus', status: SubscriptionStatus.ACTIVE })
    })
  })

  describe('setOverride', () => {
    // A deviation is a deviation FROM something; a free-tier rider has no agreement to amend.
    it('refuses when the rider holds no live subscription', async () => {
      await expect(
        service.setOverride(platformAdmin, 'user1', {
          entitlementOverride: { bookingDiscountBps: 2_500 },
        }),
      ).rejects.toBeInstanceOf(LiveSubscriptionNotFoundError)
      expect(prisma.driverSubscription.update).not.toHaveBeenCalled()
    })

    it('stores a validated deviation on the live subscription', async () => {
      prisma.driverSubscription.findFirst.mockResolvedValue({
        id: 'dsub1',
        planId: 'dplan_plus',
        status: SubscriptionStatus.ACTIVE,
        entitlementOverride: null,
      })

      await service.setOverride(platformAdmin, 'user1', {
        entitlementOverride: { bookingDiscountBps: 2_500 },
      })

      expect(prisma.driverSubscription.update.mock.calls[0]![0].data.entitlementOverride).toEqual({
        bookingDiscountBps: 2_500,
      })
      expect(prisma.auditLog.create.mock.calls[0]![0].data.action).toBe(
        'driver_subscription.override_set',
      )
    })

    it('rejects an invalid deviation rather than storing it', async () => {
      prisma.driverSubscription.findFirst.mockResolvedValue({
        id: 'dsub1',
        planId: 'dplan_plus',
        status: SubscriptionStatus.ACTIVE,
        entitlementOverride: null,
      })

      await expect(
        service.setOverride(platformAdmin, 'user1', {
          entitlementOverride: { bookingDiscountBps: 99_999 },
        }),
      ).rejects.toThrow()
      expect(prisma.driverSubscription.update).not.toHaveBeenCalled()
    })
  })

  describe('getDriverSubscription', () => {
    it('reports the free tier for a rider with no subscription', async () => {
      const view = await service.getDriverSubscription(platformAdmin, 'user1')

      expect(view.source).toBe('free')
      expect(view.planId).toBeNull()
      expect(view.cancelAtPeriodEnd).toBe(false)
      expect(view.entitlementOverride).toBeNull()
    })
  })
})
