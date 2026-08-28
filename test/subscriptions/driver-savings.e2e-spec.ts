import { BookingStatus, LifecycleStatus } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { NotificationsService } from '../../src/notifications/notifications.service'
import type { PrismaService } from '../../src/prisma/prisma.service'
import {
  DriverSavingsService,
  SAVINGS_SUMMARY_AUDIT_ACTION,
  SAVINGS_WINDOW_DAYS,
} from '../../src/subscriptions/driver-savings.service'
import { truncateAll } from '../utils/db'
import {
  seedBooking,
  seedDriverSubscription,
  seedDriverSubscriptionPlan,
  seedFacility,
  seedOperator,
  seedUser,
} from '../utils/seed'
import { createTestApp } from '../utils/test-app'

const CENTRE = { lat: 37.9838, lng: 23.7275 }
const NOW = new Date('2026-08-27T12:00:00.000Z')
const DAY_MS = 24 * 60 * 60 * 1000

function daysBefore(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS)
}

/**
 * The savings aggregate against a real Postgres. The unit spec proves the query is SHAPED
 * correctly against mocks; only this one proves the column the migration added actually
 * stores what the code thinks, that NULL and 0 are distinguishable in SQL rather than only
 * in TypeScript, and that Prisma's groupBy over a nullable Int sums the way the nudge
 * depends on.
 */
describe('driver savings summaries (e2e)', () => {
  let app: NestFastifyApplication
  let prisma: PrismaService
  let raw: PrismaClient
  let savings: DriverSavingsService
  let send: jest.SpyInstance

  let facilityId: string

  beforeAll(async () => {
    const testApp = await createTestApp()
    app = testApp.app
    prisma = testApp.prisma
    raw = prisma as unknown as PrismaClient
    savings = app.get(DriverSavingsService)
    // The only outbound side effect in the flow. Spied rather than stubbed at the module
    // level so the real service, its safeSend and its formatting all stay in the path.
    send = jest.spyOn(app.get(NotificationsService), 'sendDriverSavingsSummary')
  })

  afterAll(async () => {
    send.mockRestore()
    await app.close()
  })

  beforeEach(async () => {
    await truncateAll(raw)
    send.mockReset()
    send.mockResolvedValue(true)

    const operator = await seedOperator(raw)
    const facility = await seedFacility(raw, { operatorId: operator.id, ...CENTRE })
    facilityId = facility.id
  })

  async function rider(): Promise<string> {
    const user = await seedUser(raw)
    return user.id
  }

  function booking(
    userId: string,
    opts: { discountCents?: number; status?: BookingStatus; startsAt?: Date; currency?: string },
  ) {
    const startsAt = opts.startsAt ?? daysBefore(2)
    return seedBooking(raw, {
      facilityId,
      userId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 2 * 60 * 60_000),
      status: opts.status ?? BookingStatus.CONFIRMED,
      ...(opts.discountCents === undefined ? {} : { discountCents: opts.discountCents }),
      ...(opts.currency ? { currency: opts.currency } : {}),
    })
  }

  describe('the column the migration added', () => {
    it('stores NULL for a row written without one, and 0 as a real value', async () => {
      const userId = await rider()
      const legacy = await booking(userId, {})
      const zero = await booking(userId, { discountCents: 0 })

      expect(legacy.discountCents).toBeNull()
      expect(zero.discountCents).toBe(0)
    })

    it('does not count an explicit zero or an unknown as a saving', async () => {
      const userId = await rider()
      await booking(userId, {})
      await booking(userId, { discountCents: 0 })

      await expect(savings.sumForRider(userId, savings.periodFor(NOW))).resolves.toBe(0)
    })
  })

  describe('the aggregate', () => {
    it('sums the recorded discounts of stays that happened', async () => {
      const userId = await rider()
      await booking(userId, { discountCents: 250 })
      await booking(userId, { discountCents: 175, status: BookingStatus.CHECKED_OUT })
      await booking(userId, { discountCents: 100, status: BookingStatus.CHECKED_IN })

      await expect(savings.sumForRider(userId, savings.periodFor(NOW))).resolves.toBe(525)
    })

    it('excludes bookings that were cancelled, expired, unpaid or refunded', async () => {
      const userId = await rider()
      await booking(userId, { discountCents: 400, status: BookingStatus.CANCELLED })
      await booking(userId, { discountCents: 400, status: BookingStatus.EXPIRED })
      await booking(userId, { discountCents: 400, status: BookingStatus.PENDING_PAYMENT })
      await booking(userId, { discountCents: 400, status: BookingStatus.REFUNDED })
      await booking(userId, { discountCents: 400, status: BookingStatus.REFUND_PENDING })
      await booking(userId, { discountCents: 60 })

      await expect(savings.sumForRider(userId, savings.periodFor(NOW))).resolves.toBe(60)
    })

    it('windows to the trailing period, excluding a stay one day too old', async () => {
      const userId = await rider()
      await booking(userId, { discountCents: 500, startsAt: daysBefore(SAVINGS_WINDOW_DAYS + 1) })
      await booking(userId, { discountCents: 300, startsAt: daysBefore(SAVINGS_WINDOW_DAYS - 1) })

      await expect(savings.sumForRider(userId, savings.periodFor(NOW))).resolves.toBe(300)
    })

    it('keeps riders apart and omits anyone with nothing to report', async () => {
      const saver = await rider()
      const nonSaver = await rider()
      await booking(saver, { discountCents: 900 })
      await booking(nonSaver, { discountCents: 0 })

      const riders = await savings.findRidersWithSavings(savings.periodFor(NOW))

      expect(riders).toEqual([{ userId: saver, currency: 'EUR', savedCents: 900 }])
    })
  })

  describe('the sweep', () => {
    it('mails a saving rider, names their plan and files the period', async () => {
      const userId = await rider()
      const plan = await seedDriverSubscriptionPlan(raw, { name: 'Driver Plus' })
      await seedDriverSubscription(raw, { userId, planId: plan.id })
      await booking(userId, { discountCents: 1_234 })

      const run = await savings.sendSavingsSummaries(NOW)

      expect(run.sent).toBe(1)
      expect(send).toHaveBeenCalledTimes(1)
      expect(send.mock.calls[0]![0]).toMatchObject({
        savedCents: 1_234,
        currency: 'EUR',
        planName: 'Driver Plus',
      })

      const audit = await raw.auditLog.findFirst({
        where: { action: SAVINGS_SUMMARY_AUDIT_ACTION, entityId: userId },
      })
      expect(audit?.entityType).toBe('User')
      expect(audit?.payload).toEqual({
        periodStart: daysBefore(SAVINGS_WINDOW_DAYS).toISOString(),
        periodEnd: NOW.toISOString(),
        savedCents: 1_234,
      })
    })

    it('is idempotent across a re-run for the same window', async () => {
      const userId = await rider()
      await booking(userId, { discountCents: 700 })

      const first = await savings.sendSavingsSummaries(NOW)
      const second = await savings.sendSavingsSummaries(NOW)

      expect(first.sent).toBe(1)
      expect(second.sent).toBe(0)
      expect(second.alreadySummarised).toBe(1)
      expect(send).toHaveBeenCalledTimes(1)
      await expect(
        raw.auditLog.count({ where: { action: SAVINGS_SUMMARY_AUDIT_ACTION } }),
      ).resolves.toBe(1)
    })

    it('mails again once the recorded summary falls outside the window', async () => {
      const userId = await rider()
      await booking(userId, { discountCents: 700 })
      await savings.sendSavingsSummaries(NOW)

      const later = new Date(NOW.getTime() + (SAVINGS_WINDOW_DAYS + 1) * DAY_MS)
      await booking(userId, { discountCents: 200, startsAt: new Date(NOW.getTime() + DAY_MS) })

      const run = await savings.sendSavingsSummaries(later)

      expect(run.sent).toBe(1)
      expect(send).toHaveBeenCalledTimes(2)
      expect(send.mock.calls[1]![0]).toMatchObject({ savedCents: 200 })
    })

    it('never mails an archived account', async () => {
      const userId = await rider()
      await raw.user.update({
        where: { id: userId },
        data: { lifecycleStatus: LifecycleStatus.ARCHIVED },
      })
      await booking(userId, { discountCents: 700 })

      const run = await savings.sendSavingsSummaries(NOW)

      expect(send).not.toHaveBeenCalled()
      expect(run.unreachable).toBe(1)
      await expect(
        raw.auditLog.count({ where: { action: SAVINGS_SUMMARY_AUDIT_ACTION } }),
      ).resolves.toBe(0)
    })
  })
})
