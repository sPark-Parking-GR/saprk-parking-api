import { BookingStatus, LifecycleStatus } from '@prisma/client'
import type { NotificationsService } from '../notifications/notifications.service'
import type { PrismaService } from '../prisma/prisma.service'
import {
  DriverSavingsService,
  SAVINGS_SUMMARY_AUDIT_ACTION,
  SAVINGS_WINDOW_DAYS,
} from './driver-savings.service'

const NOW = new Date('2026-08-27T12:00:00.000Z')
const WINDOW_MS = SAVINGS_WINDOW_DAYS * 24 * 60 * 60 * 1000

interface PrismaMock {
  booking: { aggregate: jest.Mock; groupBy: jest.Mock }
  auditLog: { findMany: jest.Mock; create: jest.Mock }
  user: { findMany: jest.Mock }
  driverSubscription: { findMany: jest.Mock }
}

describe('DriverSavingsService', () => {
  let prisma: PrismaMock
  let notifications: { sendDriverSavingsSummary: jest.Mock }
  let service: DriverSavingsService

  function group(userId: string, savedCents: number, currency = 'EUR') {
    return { userId, currency, _sum: { discountCents: savedCents } }
  }

  function reachable(...ids: string[]) {
    return ids.map((id) => ({ id, email: `${id}@example.com`, displayName: null }))
  }

  beforeEach(() => {
    prisma = {
      booking: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { discountCents: null } }),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      auditLog: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn().mockResolvedValue({}) },
      user: { findMany: jest.fn().mockResolvedValue([]) },
      driverSubscription: { findMany: jest.fn().mockResolvedValue([]) },
    }
    notifications = { sendDriverSavingsSummary: jest.fn().mockResolvedValue(true) }
    service = new DriverSavingsService(
      prisma as unknown as PrismaService,
      notifications as unknown as NotificationsService,
    )
  })

  describe('the window', () => {
    it('trails the supplied clock by exactly the window length', () => {
      const period = service.periodFor(NOW)

      expect(period.end).toEqual(NOW)
      expect(period.start).toEqual(new Date(NOW.getTime() - WINDOW_MS))
    })

    it('windows the aggregate on startsAt, half-open at the far end', async () => {
      await service.sumForRider('u1', service.periodFor(NOW))

      const { where } = prisma.booking.aggregate.mock.calls[0]![0]
      expect(where.startsAt.gte).toEqual(new Date(NOW.getTime() - WINDOW_MS))
      expect(where.startsAt.lt).toEqual(NOW)
      expect(where.createdAt).toBeUndefined()
    })
  })

  describe('what counts towards a saving', () => {
    it('sums only bookings that were actually paid for', async () => {
      await service.sumForRider('u1', service.periodFor(NOW))

      const { where } = prisma.booking.aggregate.mock.calls[0]![0]
      expect(where.status.in).toEqual([
        BookingStatus.CONFIRMED,
        BookingStatus.CHECKED_IN,
        BookingStatus.CHECKED_OUT,
      ])
    })

    it('excludes cancelled, expired, unpaid and refunded bookings', async () => {
      await service.sumForRider('u1', service.periodFor(NOW))

      const counted: BookingStatus[] = prisma.booking.aggregate.mock.calls[0]![0].where.status.in
      for (const excluded of [
        BookingStatus.CANCELLED,
        BookingStatus.EXPIRED,
        BookingStatus.PENDING_PAYMENT,
        BookingStatus.REFUND_PENDING,
        BookingStatus.REFUNDED,
      ]) {
        expect(counted).not.toContain(excluded)
      }
    })

    /**
     * The distinction the nullable column exists for: a pre-migration row knows nothing, and
     * `> 0` is what stops it being read as a zero-saving measurement.
     */
    it('reads only rows that carry a positive recorded discount', async () => {
      await service.sumForRider('u1', service.periodFor(NOW))

      expect(prisma.booking.aggregate.mock.calls[0]![0].where.discountCents).toEqual({ gt: 0 })
    })

    it('reports zero rather than null for a rider with nothing in the window', async () => {
      await expect(service.sumForRider('u1', service.periodFor(NOW))).resolves.toBe(0)
    })

    it('returns the summed discount for a rider who saved', async () => {
      prisma.booking.aggregate.mockResolvedValue({ _sum: { discountCents: 1_250 } })

      await expect(service.sumForRider('u1', service.periodFor(NOW))).resolves.toBe(1_250)
    })
  })

  describe('candidate selection', () => {
    it('groups by rider and currency and carries the summed total', async () => {
      prisma.booking.groupBy.mockResolvedValue([group('u1', 800), group('u2', 150)])

      const riders = await service.findRidersWithSavings(service.periodFor(NOW))

      expect(prisma.booking.groupBy.mock.calls[0]![0].by).toEqual(['userId', 'currency'])
      expect(riders).toEqual([
        { userId: 'u1', currency: 'EUR', savedCents: 800 },
        { userId: 'u2', currency: 'EUR', savedCents: 150 },
      ])
    })

    /**
     * Zero-sum riders are excluded structurally rather than by a `having` clause: every row
     * that reaches the aggregate is already `> 0`, so no group can sum to zero.
     */
    it('cannot surface a zero-sum rider, because the row filter precedes the grouping', async () => {
      prisma.booking.groupBy.mockResolvedValue([])

      const run = await service.sendSavingsSummaries(NOW)

      expect(prisma.booking.groupBy.mock.calls[0]![0].where.discountCents).toEqual({ gt: 0 })
      expect(run.candidates).toBe(0)
      expect(notifications.sendDriverSavingsSummary).not.toHaveBeenCalled()
    })

    it('does not touch the recipient, plan or audit tables when nobody qualifies', async () => {
      await service.sendSavingsSummaries(NOW)

      expect(prisma.user.findMany).not.toHaveBeenCalled()
      expect(prisma.auditLog.findMany).not.toHaveBeenCalled()
      expect(prisma.driverSubscription.findMany).not.toHaveBeenCalled()
    })
  })

  describe('sending', () => {
    beforeEach(() => {
      prisma.booking.groupBy.mockResolvedValue([group('u1', 1_234)])
      prisma.user.findMany.mockResolvedValue(reachable('u1'))
    })

    it('mails the rider their total and names their live plan', async () => {
      prisma.driverSubscription.findMany.mockResolvedValue([
        { userId: 'u1', plan: { name: 'Plus' } },
      ])

      const run = await service.sendSavingsSummaries(NOW)

      expect(notifications.sendDriverSavingsSummary).toHaveBeenCalledWith({
        to: 'u1@example.com',
        riderName: null,
        savedCents: 1_234,
        currency: 'EUR',
        planName: 'Plus',
        periodStart: new Date(NOW.getTime() - WINDOW_MS),
        periodEnd: NOW,
      })
      expect(run.sent).toBe(1)
    })

    it('still mails a rider whose subscription has since lapsed, with no plan named', async () => {
      const run = await service.sendSavingsSummaries(NOW)

      expect(notifications.sendDriverSavingsSummary.mock.calls[0]![0].planName).toBeNull()
      expect(run.sent).toBe(1)
    })

    it('never mails a deleted or non-ACTIVE account', async () => {
      prisma.user.findMany.mockResolvedValue([])

      const run = await service.sendSavingsSummaries(NOW)

      const { where } = prisma.user.findMany.mock.calls[0]![0]
      expect(where.deletedAt).toBeNull()
      expect(where.lifecycleStatus).toBe(LifecycleStatus.ACTIVE)
      expect(notifications.sendDriverSavingsSummary).not.toHaveBeenCalled()
      expect(run.unreachable).toBe(1)
    })

    it('refuses to sum unlike currencies into one headline figure', async () => {
      prisma.booking.groupBy.mockResolvedValue([group('u1', 1_000), group('u1', 400, 'GBP')])

      const run = await service.sendSavingsSummaries(NOW)

      expect(notifications.sendDriverSavingsSummary).not.toHaveBeenCalled()
      expect(run.mixedCurrency).toBe(1)
      expect(run.candidates).toBe(1)
    })
  })

  describe('dedup per period', () => {
    beforeEach(() => {
      prisma.booking.groupBy.mockResolvedValue([group('u1', 900)])
      prisma.user.findMany.mockResolvedValue(reachable('u1'))
    })

    it('files the period and the figure against the rider once delivered', async () => {
      await service.sendSavingsSummaries(NOW)

      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: {
          action: SAVINGS_SUMMARY_AUDIT_ACTION,
          entityType: 'User',
          entityId: 'u1',
          payload: {
            periodStart: new Date(NOW.getTime() - WINDOW_MS).toISOString(),
            periodEnd: NOW.toISOString(),
            savedCents: 900,
          },
        },
      })
    })

    it('looks for an overlapping summary, which is any row inside the window', async () => {
      await service.sendSavingsSummaries(NOW)

      const { where } = prisma.auditLog.findMany.mock.calls[0]![0]
      expect(where.action).toBe(SAVINGS_SUMMARY_AUDIT_ACTION)
      expect(where.entityType).toBe('User')
      expect(where.entityId).toEqual({ in: ['u1'] })
      expect(where.createdAt).toEqual({ gte: new Date(NOW.getTime() - WINDOW_MS) })
    })

    it('does not send twice for an overlapping period', async () => {
      prisma.auditLog.findMany.mockResolvedValue([{ entityId: 'u1' }])

      const run = await service.sendSavingsSummaries(NOW)

      expect(notifications.sendDriverSavingsSummary).not.toHaveBeenCalled()
      expect(prisma.auditLog.create).not.toHaveBeenCalled()
      expect(run.alreadySummarised).toBe(1)
      expect(run.sent).toBe(0)
    })

    /**
     * The same rider, the same audit history, a clock moved past the previous window: the row
     * no longer overlaps and the nudge is due again. This is what makes a daily sweep produce
     * a rolling monthly cadence per rider rather than daily mail.
     */
    it('sends again once the previous summary falls out of the window', async () => {
      const sentAt = new Date(NOW.getTime() - WINDOW_MS - 1_000)
      prisma.auditLog.findMany.mockImplementation((args: { where: { createdAt: { gte: Date } } }) =>
        Promise.resolve(sentAt >= args.where.createdAt.gte ? [{ entityId: 'u1' }] : []),
      )

      const run = await service.sendSavingsSummaries(NOW)

      expect(run.sent).toBe(1)
      expect(notifications.sendDriverSavingsSummary).toHaveBeenCalledTimes(1)
    })

    /**
     * A bounced nudge must stay retryable. Recording it anyway would spend the rider's only
     * slot for the window on an email that never arrived.
     */
    it('records nothing when delivery fails, so the next sweep retries', async () => {
      notifications.sendDriverSavingsSummary.mockResolvedValue(false)

      const run = await service.sendSavingsSummaries(NOW)

      expect(prisma.auditLog.create).not.toHaveBeenCalled()
      expect(run.failed).toBe(1)
      expect(run.sent).toBe(0)
    })

    it('keeps going after one rider fails to receive theirs', async () => {
      prisma.booking.groupBy.mockResolvedValue([group('u1', 900), group('u2', 300)])
      prisma.user.findMany.mockResolvedValue(reachable('u1', 'u2'))
      notifications.sendDriverSavingsSummary
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true)

      const run = await service.sendSavingsSummaries(NOW)

      expect(run.failed).toBe(1)
      expect(run.sent).toBe(1)
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1)
    })
  })

  describe('the run summary', () => {
    it('accounts for every candidate exactly once', async () => {
      prisma.booking.groupBy.mockResolvedValue([
        group('sent', 100),
        group('dup', 100),
        group('gone', 100),
        group('mixed', 100),
        group('mixed', 100, 'GBP'),
      ])
      prisma.user.findMany.mockResolvedValue(reachable('sent', 'dup', 'mixed'))
      prisma.auditLog.findMany.mockResolvedValue([{ entityId: 'dup' }])

      const run = await service.sendSavingsSummaries(NOW)

      expect(run.candidates).toBe(4)
      expect(run.sent + run.alreadySummarised + run.unreachable + run.mixedCurrency + run.failed).toBe(
        run.candidates,
      )
      expect(run).toMatchObject({ sent: 1, alreadySummarised: 1, unreachable: 1, mixedCurrency: 1 })
    })
  })
})
