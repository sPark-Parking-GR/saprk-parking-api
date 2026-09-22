import { OperatorMemberRole } from '@prisma/client'
import type { ConfigService } from '@nestjs/config'
import type { Entitlements, OperatorUsage } from '@spark/types'
import type { NotificationsService } from '../notifications/notifications.service'
import type { PrismaService } from '../prisma/prisma.service'
import type { EntitlementService } from './entitlement.service'
import { QUOTA_THRESHOLD_WARNED_ACTION, QuotaThresholdService } from './quota-threshold.service'

const WEB_APP_URL = 'https://app.spark.gr'

const entitlementsWith = (over: Partial<Entitlements> = {}): Entitlements => ({
  maxFacilities: null,
  maxTariffPlans: null,
  maxStaffSeats: null,
  features: [],
  commissionBps: 0,
  ...over,
})

const usageWith = (over: Partial<OperatorUsage> = {}): OperatorUsage => ({
  facilities: 0,
  tariffPlans: 0,
  staffSeats: 0,
  ...over,
})

describe('QuotaThresholdService', () => {
  let prisma: {
    parkingOperator: { findUnique: jest.Mock }
    user: { findMany: jest.Mock }
    auditLog: { findFirst: jest.Mock; create: jest.Mock }
  }
  let entitlements: { isQuotaExempt: jest.Mock; describe: jest.Mock }
  let notifications: { sendOperatorQuotaThreshold: jest.Mock }
  let service: QuotaThresholdService

  function resolvesTo(
    limits: Partial<Entitlements>,
    usage: Partial<OperatorUsage>,
    subscriptionId: string | null = 'sub-1',
  ): void {
    entitlements.describe.mockResolvedValue({
      entitlements: entitlementsWith(limits),
      usage: usageWith(usage),
      subscriptionId,
    })
  }

  function payloads(): Record<string, unknown>[] {
    return prisma.auditLog.create.mock.calls.map(
      (call: [{ data: { payload: Record<string, unknown> } }]) => call[0].data.payload,
    )
  }

  beforeEach(() => {
    prisma = {
      parkingOperator: { findUnique: jest.fn().mockResolvedValue({ name: 'Acme Parking' }) },
      user: { findMany: jest.fn().mockResolvedValue([{ email: 'owner@acme.gr' }]) },
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
      },
    }
    entitlements = {
      isQuotaExempt: jest.fn().mockReturnValue(false),
      describe: jest.fn(),
    }
    notifications = { sendOperatorQuotaThreshold: jest.fn().mockResolvedValue(true) }

    service = new QuotaThresholdService(
      prisma as unknown as PrismaService,
      entitlements as unknown as EntitlementService,
      notifications as unknown as NotificationsService,
      { getOrThrow: jest.fn().mockReturnValue(WEB_APP_URL) } as unknown as ConfigService,
    )
  })

  describe('threshold detection', () => {
    it('warns once at 80% with the resource, the numbers and the billing link', async () => {
      resolvesTo({ maxFacilities: 5 }, { facilities: 4 })

      await service.checkOperatorQuotaThresholds('op1')

      expect(notifications.sendOperatorQuotaThreshold).toHaveBeenCalledTimes(1)
      expect(notifications.sendOperatorQuotaThreshold).toHaveBeenCalledWith({
        to: 'owner@acme.gr',
        businessName: 'Acme Parking',
        resourceLabel: 'facilities',
        current: 4,
        limit: 5,
        threshold: 80,
        billingUrl: `${WEB_APP_URL}/dashboard/billing`,
      })
      expect(payloads()).toEqual([
        { resource: 'facilities', threshold: 80, current: 4, limit: 5, notified: true },
      ])
    })

    it('stays silent below 80%', async () => {
      resolvesTo({ maxFacilities: 5 }, { facilities: 3 })

      await service.checkOperatorQuotaThresholds('op1')

      expect(notifications.sendOperatorQuotaThreshold).not.toHaveBeenCalled()
      expect(prisma.auditLog.create).not.toHaveBeenCalled()
    })

    /**
     * The boundary is inclusive and computed in integers. 4/5 is exactly 80% and must warn;
     * a float ratio compared against 0.8 is the shape that gets this wrong.
     */
    it('treats a limit of 3 with 2 used as below the boundary and 3 as at it', async () => {
      resolvesTo({ maxTariffPlans: 3 }, { tariffPlans: 2 })
      await service.checkOperatorQuotaThresholds('op1')
      expect(notifications.sendOperatorQuotaThreshold).not.toHaveBeenCalled()

      resolvesTo({ maxTariffPlans: 3 }, { tariffPlans: 3 })
      await service.checkOperatorQuotaThresholds('op1')
      expect(notifications.sendOperatorQuotaThreshold).toHaveBeenCalledTimes(1)
    })

    it('never warns on an unlimited quota', async () => {
      resolvesTo({ maxFacilities: null }, { facilities: 9999 })

      await service.checkOperatorQuotaThresholds('op1')

      expect(notifications.sendOperatorQuotaThreshold).not.toHaveBeenCalled()
      expect(prisma.auditLog.create).not.toHaveBeenCalled()
    })

    // A plan granting none of a resource has no percentage of it to be at.
    it('says nothing about a zero limit nobody has exceeded', async () => {
      resolvesTo({ maxStaffSeats: 0 }, { staffSeats: 0 })

      await service.checkOperatorQuotaThresholds('op1')

      expect(prisma.auditLog.create).not.toHaveBeenCalled()
    })

    it('warns when usage exceeds a zero limit left behind by a downgrade', async () => {
      resolvesTo({ maxStaffSeats: 0 }, { staffSeats: 2 })

      await service.checkOperatorQuotaThresholds('op1')

      expect(notifications.sendOperatorQuotaThreshold).toHaveBeenCalledWith(
        expect.objectContaining({ resourceLabel: 'staff seats', threshold: 100, current: 2 }),
      )
    })

    it('mails only the 100% nudge when a single create crosses both, recording the quieter one', async () => {
      resolvesTo({ maxFacilities: 1 }, { facilities: 1 })

      await service.checkOperatorQuotaThresholds('op1')

      expect(notifications.sendOperatorQuotaThreshold).toHaveBeenCalledTimes(1)
      expect(notifications.sendOperatorQuotaThreshold).toHaveBeenCalledWith(
        expect.objectContaining({ threshold: 100 }),
      )
      expect(payloads()).toEqual([
        { resource: 'facilities', threshold: 80, current: 1, limit: 1, notified: false },
        { resource: 'facilities', threshold: 100, current: 1, limit: 1, notified: true },
      ])
    })

    it('warns per resource, so two quotas at once produce two nudges', async () => {
      resolvesTo({ maxFacilities: 5, maxTariffPlans: 5 }, { facilities: 4, tariffPlans: 4 })

      await service.checkOperatorQuotaThresholds('op1')

      expect(
        notifications.sendOperatorQuotaThreshold.mock.calls.map(
          (call: [{ resourceLabel: string }]) => call[0].resourceLabel,
        ),
      ).toEqual(['facilities', 'tariff plans'])
    })

    it('does nothing at all for a quota-exempt operator', async () => {
      entitlements.isQuotaExempt.mockReturnValue(true)

      await service.checkOperatorQuotaThresholds('osm-unclaimed-operator')

      expect(entitlements.describe).not.toHaveBeenCalled()
      expect(prisma.auditLog.create).not.toHaveBeenCalled()
    })
  })

  describe('dedup through the audit log', () => {
    it('keys the existence check on the live subscription id, the resource and the threshold', async () => {
      resolvesTo({ maxFacilities: 5 }, { facilities: 4 }, 'sub-live')

      await service.checkOperatorQuotaThresholds('op1')

      expect(prisma.auditLog.findFirst).toHaveBeenCalledWith({
        where: {
          action: QUOTA_THRESHOLD_WARNED_ACTION,
          entityType: 'OperatorSubscription',
          entityId: 'sub-live',
          AND: [
            { payload: { path: ['resource'], equals: 'facilities' } },
            { payload: { path: ['threshold'], equals: 80 } },
          ],
        },
        select: { id: true },
      })
    })

    it('sends nothing a second time once the threshold is recorded', async () => {
      resolvesTo({ maxFacilities: 5 }, { facilities: 4 })
      prisma.auditLog.findFirst.mockResolvedValue({ id: 'audit-existing' })

      await service.checkOperatorQuotaThresholds('op1')

      expect(notifications.sendOperatorQuotaThreshold).not.toHaveBeenCalled()
      expect(prisma.auditLog.create).not.toHaveBeenCalled()
    })

    /**
     * The dedup resets by construction: a different subscription id is an entity nothing was
     * ever recorded against, so an upgrade re-arms every threshold without a cleanup step.
     */
    it('re-arms against a new subscription id', async () => {
      resolvesTo({ maxFacilities: 5 }, { facilities: 4 }, 'sub-upgraded')
      prisma.auditLog.findFirst.mockImplementation(({ where }: { where: { entityId: string } }) =>
        where.entityId === 'sub-old' ? { id: 'audit-old' } : null,
      )

      await service.checkOperatorQuotaThresholds('op1')

      expect(notifications.sendOperatorQuotaThreshold).toHaveBeenCalledTimes(1)
    })

    it('records against the operator when no live subscription resolves the plan', async () => {
      resolvesTo({ maxFacilities: 5 }, { facilities: 4 }, null)

      await service.checkOperatorQuotaThresholds('op1')

      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ entityType: 'ParkingOperator', entityId: 'op1' }),
      })
    })

    it('writes the record with no actor and the warned action', async () => {
      resolvesTo({ maxFacilities: 5 }, { facilities: 4 })

      await service.checkOperatorQuotaThresholds('op1')

      const { data } = prisma.auditLog.create.mock.calls[0]![0]
      expect(data.action).toBe(QUOTA_THRESHOLD_WARNED_ACTION)
      expect(data.actorId).toBeUndefined()
      expect(data.actorRole).toBeUndefined()
    })
  })

  describe('recipients', () => {
    it('mails the operator administrators and nobody else', async () => {
      resolvesTo({ maxFacilities: 5 }, { facilities: 4 })
      prisma.user.findMany.mockResolvedValue([{ email: 'a@acme.gr' }, { email: 'b@acme.gr' }])

      await service.checkOperatorQuotaThresholds('op1')

      expect(prisma.user.findMany).toHaveBeenCalledWith({
        where: {
          operatorMemberships: { some: { operatorId: 'op1', role: OperatorMemberRole.ADMIN } },
        },
        select: { email: true },
        orderBy: { createdAt: 'asc' },
      })
      expect(notifications.sendOperatorQuotaThreshold).toHaveBeenCalledTimes(2)
    })

    // Recording a nudge nobody received would deny it to the first admin who ever exists.
    it('records nothing when the operator has no administrator to tell', async () => {
      resolvesTo({ maxFacilities: 5 }, { facilities: 4 })
      prisma.user.findMany.mockResolvedValue([])

      await service.checkOperatorQuotaThresholds('op1')

      expect(prisma.auditLog.create).not.toHaveBeenCalled()
      expect(notifications.sendOperatorQuotaThreshold).not.toHaveBeenCalled()
    })
  })

  describe('failure tolerance', () => {
    it('records the threshold before mailing it', async () => {
      resolvesTo({ maxFacilities: 5 }, { facilities: 4 })
      const order: string[] = []
      prisma.auditLog.create.mockImplementation(async () => {
        order.push('audit')
        return { id: 'audit-1' }
      })
      notifications.sendOperatorQuotaThreshold.mockImplementation(async () => {
        order.push('email')
        return true
      })

      await service.checkOperatorQuotaThresholds('op1')

      expect(order).toEqual(['audit', 'email'])
    })

    it('swallows an entitlement resolution failure rather than failing the caller', async () => {
      entitlements.describe.mockRejectedValue(new Error('database gone'))

      await expect(service.checkOperatorQuotaThresholds('op1')).resolves.toBeUndefined()
    })

    it('swallows a notification failure rather than failing the caller', async () => {
      resolvesTo({ maxFacilities: 5 }, { facilities: 4 })
      notifications.sendOperatorQuotaThreshold.mockRejectedValue(new Error('smtp down'))

      await expect(service.checkOperatorQuotaThresholds('op1')).resolves.toBeUndefined()
    })
  })
})
