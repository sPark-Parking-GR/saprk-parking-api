import { Prisma } from '@prisma/client'
import type { AuthUser } from '@spark/types'
import type { OperatorScope, OperatorScopeService } from '../common/authz/operator-scope.service'
import {
  AnalyticsScopeForbiddenError,
  MixedCurrencyAnalyticsError,
  SubscriptionFeatureRequiredError,
} from '../common/errors/domain.errors'
import type { PrismaService } from '../prisma/prisma.service'
import type { EntitlementService } from '../subscriptions/entitlement.service'
import { AnalyticsService } from './analytics.service'

// Rebuilds the Sql the tagged template would have produced, so a test can inspect the
// placeholder text and the bound values separately.
const sqlOf = (call: unknown[]): Prisma.Sql =>
  Prisma.sql(call[0] as readonly string[], ...call.slice(1))

const from = new Date('2026-07-01T00:00:00Z')
const to = new Date('2026-08-01T00:00:00Z')

const operatorUser = { id: 'u1', role: 'operator_admin' } as AuthUser
const platformUser = { id: 'u2', role: 'platform_admin' } as AuthUser

const revenueRow = (over: Partial<Record<string, unknown>> = {}) => ({
  currency: 'EUR',
  gross_cents: BigInt(10_000),
  refunded_cents: BigInt(0),
  booking_count: 4,
  ...over,
})

const occupancyRow = (booked: number, capacity: number) => ({
  booked_minutes: BigInt(booked),
  capacity_minutes: BigInt(capacity),
})

function setup(scope: OperatorScope, hasFeature = true) {
  const prisma = { $queryRaw: jest.fn().mockResolvedValue([]) }
  const operatorScope = { resolve: jest.fn().mockResolvedValue(scope) }
  const entitlements = { hasFeature: jest.fn().mockResolvedValue(hasFeature) }
  const service = new AnalyticsService(
    prisma as unknown as PrismaService,
    operatorScope as unknown as OperatorScopeService,
    entitlements as unknown as EntitlementService,
  )
  return { prisma, operatorScope, entitlements, service }
}

describe('AnalyticsService revenue definition', () => {
  it('counts only settled payment statuses, never PENDING or FAILED', async () => {
    const { prisma, service } = setup({ kind: 'platform' })
    prisma.$queryRaw.mockResolvedValueOnce([revenueRow()]).mockResolvedValueOnce([])

    await service.summary(platformUser, { from, to })

    const sql = sqlOf(prisma.$queryRaw.mock.calls[0]!)
    expect(sql.values).toEqual(
      expect.arrayContaining(['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED']),
    )
    expect(sql.values).not.toContain('PENDING')
    expect(sql.values).not.toContain('FAILED')
    // Only a SUCCEEDED refund reduces revenue; a pending or failed one is money still held.
    expect(sql.text).toContain('LEFT JOIN "Refund" r')
  })

  it('nets a fully refunded booking to zero revenue and excludes it from the count', async () => {
    const { prisma, service } = setup({ kind: 'platform' })
    prisma.$queryRaw
      .mockResolvedValueOnce([
        revenueRow({ gross_cents: BigInt(2_500), refunded_cents: BigInt(2_500), booking_count: 0 }),
      ])
      .mockResolvedValueOnce([])

    const result = await service.summary(platformUser, { from, to })

    expect(result.grossRevenueCents).toBe(2_500)
    expect(result.refundedCents).toBe(2_500)
    expect(result.netRevenueCents).toBe(0)
    expect(result.bookingCount).toBe(0)
    expect(result.averageTicketCents).toBe(0)
  })

  it('nets partial refunds out of gross and averages over the paid bookings', async () => {
    const { prisma, service } = setup({ kind: 'platform' })
    prisma.$queryRaw
      .mockResolvedValueOnce([
        revenueRow({
          gross_cents: BigInt(10_000),
          refunded_cents: BigInt(1_000),
          booking_count: 3,
        }),
      ])
      .mockResolvedValueOnce([])

    const result = await service.summary(platformUser, { from, to })

    expect(result.netRevenueCents).toBe(9_000)
    expect(result.averageTicketCents).toBe(3_000)
    expect(Number.isInteger(result.averageTicketCents)).toBe(true)
  })

  it('reports zeros, not nulls or NaN, for a range with no money in it', async () => {
    const { prisma, service } = setup({ kind: 'platform' })
    prisma.$queryRaw.mockResolvedValue([])

    const result = await service.summary(platformUser, { from, to })

    expect(result).toMatchObject({
      grossRevenueCents: 0,
      refundedCents: 0,
      netRevenueCents: 0,
      bookingCount: 0,
      averageTicketCents: 0,
      currency: 'EUR',
      occupancy: { bookedSlotMinutes: 0, capacitySlotMinutes: 0, ratio: 0 },
    })
    expect(Number.isNaN(result.occupancy.ratio)).toBe(false)
  })

  it('refuses to sum across currencies instead of returning a meaningless total', async () => {
    const { prisma, service } = setup({ kind: 'platform' })
    prisma.$queryRaw
      .mockResolvedValueOnce([revenueRow({ currency: 'EUR' }), revenueRow({ currency: 'GBP' })])
      .mockResolvedValueOnce([])

    await expect(service.summary(platformUser, { from, to })).rejects.toBeInstanceOf(
      MixedCurrencyAnalyticsError,
    )
  })
})

describe('AnalyticsService operator scoping', () => {
  it('restricts an operator to their own operators and never leaks another one', async () => {
    const { prisma, service } = setup({ kind: 'operator', operatorIds: ['op-1'] })

    await service.summary(operatorUser, { from, to })

    for (const call of prisma.$queryRaw.mock.calls) {
      const sql = sqlOf(call)
      expect(sql.values).toContain('op-1')
      expect(sql.values).not.toContain('op-2')
    }
    expect(sqlOf(prisma.$queryRaw.mock.calls[0]!).text).toContain('own."operatorId" IN')
  })

  it('gives a multi-membership caller the union of their operators', async () => {
    const { prisma, service } = setup({ kind: 'operator', operatorIds: ['op-1', 'op-3'] })

    await service.summary(operatorUser, { from, to })

    const sql = sqlOf(prisma.$queryRaw.mock.calls[0]!)
    expect(sql.values).toEqual(expect.arrayContaining(['op-1', 'op-3']))
    expect(sql.text).toContain('own."operatorId" IN')
  })

  it('lets a multi-membership caller narrow to one operator they belong to', async () => {
    const { prisma, service } = setup({ kind: 'operator', operatorIds: ['op-1', 'op-3'] })

    await service.summary(operatorUser, { from, to, operatorId: 'op-3' })

    const sql = sqlOf(prisma.$queryRaw.mock.calls[0]!)
    expect(sql.values).toContain('op-3')
    expect(sql.values).not.toContain('op-1')
  })

  it('refuses an operator asking about an operator they do not belong to', async () => {
    const { prisma, service } = setup({ kind: 'operator', operatorIds: ['op-1'] })

    await expect(
      service.summary(operatorUser, { from, to, operatorId: 'op-2' }),
    ).rejects.toBeInstanceOf(AnalyticsScopeForbiddenError)
    expect(prisma.$queryRaw).not.toHaveBeenCalled()
  })

  it('lets a platform admin see everything, with no operator predicate at all', async () => {
    const { prisma, service } = setup({ kind: 'platform' })

    await service.summary(platformUser, { from, to })

    for (const call of prisma.$queryRaw.mock.calls) {
      expect(sqlOf(call).text).not.toContain('"operatorId" IN')
    }
  })

  it('lets a platform admin filter down to one operator', async () => {
    const { prisma, service } = setup({ kind: 'platform' })

    await service.summary(platformUser, { from, to, operatorId: 'op-9' })

    const sql = sqlOf(prisma.$queryRaw.mock.calls[0]!)
    expect(sql.text).toContain('own."operatorId" IN')
    expect(sql.values).toContain('op-9')
  })
})

/**
 * The regression guard for the entire design. Attributing through Facility.operatorId
 * would pass every other test in this file and silently rewrite historical payouts the
 * first time a facility is reassigned.
 */
describe('AnalyticsService ownership-period attribution', () => {
  it('resolves the owner from the period containing the settlement instant', async () => {
    const { prisma, service } = setup({ kind: 'operator', operatorIds: ['op-1'] })

    await service.summary(operatorUser, { from, to })

    const sql = sqlOf(prisma.$queryRaw.mock.calls[0]!)
    expect(sql.text).toContain('"FacilityOwnershipPeriod"')
    expect(sql.text).toContain('o."from" <= p."createdAt"')
    expect(sql.text).toContain('o."to" IS NULL OR o."to" > p."createdAt"')
  })

  it('never filters or groups revenue by the facility’s CURRENT operatorId', async () => {
    const { prisma, service } = setup({ kind: 'operator', operatorIds: ['op-1'] })

    await service.summary(operatorUser, { from, to })
    await service.topFacilities(operatorUser, { from, to, limit: 10 })

    for (const call of prisma.$queryRaw.mock.calls) {
      const { text } = sqlOf(call)
      expect(text).not.toContain('f."operatorId"')
      expect(text).not.toContain('b."operatorId"')
      expect(text).not.toContain('"Facility"."operatorId"')
    }
  })

  it('reports a reassigned facility under its period owner, not its current owner', async () => {
    const { prisma, service } = setup({ kind: 'platform' })
    // The facility row now belongs to op-new; the period covering the settlement instant
    // says op-old, and the query reads the period, so op-old is what comes back.
    prisma.$queryRaw.mockResolvedValueOnce([
      {
        facility_id: 'f1',
        facility_name: 'Syntagma Garage',
        operator_id: 'op-old',
        currency: 'EUR',
        gross_cents: BigInt(7_500),
        refunded_cents: BigInt(0),
        booking_count: 3,
      },
    ])

    const result = await service.topFacilities(platformUser, { from, to, limit: 10 })

    expect(result.items[0]!.operatorId).toBe('op-old')
    expect(result.items[0]!.netRevenueCents).toBe(7_500)
    expect(sqlOf(prisma.$queryRaw.mock.calls[0]!).text).toContain('s.operator_id AS operator_id')
  })

  it('scopes the occupancy denominator through the period as well', async () => {
    const { prisma, service } = setup({ kind: 'operator', operatorIds: ['op-1'] })

    await service.summary(operatorUser, { from, to })

    const occupancy = sqlOf(prisma.$queryRaw.mock.calls[1]!)
    expect(occupancy.text).toContain('"FacilityOwnershipPeriod"')
    expect(occupancy.text).toContain('o."operatorId" IN')
    expect(occupancy.values).toContain('op-1')
  })
})

describe('AnalyticsService parameterisation', () => {
  it('binds every caller-supplied value instead of interpolating it into the SQL', async () => {
    const { prisma, service } = setup({ kind: 'operator', operatorIds: ["op-'; DROP TABLE"] })

    await service.revenueSeries(operatorUser, { from, to, bucket: 'week' })
    await service.topFacilities(operatorUser, { from, to, limit: 7 })

    const series = sqlOf(prisma.$queryRaw.mock.calls[0]!)
    expect(series.values).toContain("op-'; DROP TABLE")
    expect(series.values).toContain('week')
    expect(series.values).toContain(from)
    expect(series.values).toContain(to)
    expect(series.text).not.toContain('DROP TABLE')
    expect(series.text).not.toContain("'week'")
    expect(series.text).not.toContain(from.toISOString())

    const top = sqlOf(prisma.$queryRaw.mock.calls[1]!)
    expect(top.values).toContain(7)
    expect(top.text).toContain('LIMIT $')
  })

  it('fails closed rather than running unfiltered when the scope resolves to no operators', async () => {
    const { prisma, service } = setup({ kind: 'operator', operatorIds: [] })

    await service.summary(operatorUser, { from, to })

    const sql = sqlOf(prisma.$queryRaw.mock.calls[0]!)
    expect(sql.text).toContain('AND FALSE')
  })
})

describe('AnalyticsService occupancy', () => {
  it('divides booked slot-minutes by offered slot-minutes, not quota by capacity', async () => {
    const { prisma, service } = setup({ kind: 'platform' })
    prisma.$queryRaw
      .mockResolvedValueOnce([revenueRow()])
      .mockResolvedValueOnce([occupancyRow(300, 1_200)])

    const result = await service.summary(platformUser, { from, to })

    expect(result.occupancy).toEqual({
      bookedSlotMinutes: 300,
      capacitySlotMinutes: 1_200,
      ratio: 0.25,
    })

    const occupancy = sqlOf(prisma.$queryRaw.mock.calls[1]!)
    expect(occupancy.text).toContain('"onlineQuota"')
    expect(occupancy.text).not.toContain('totalCapacity')
    expect(occupancy.values).toEqual(
      expect.arrayContaining(['CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT']),
    )
  })

  it('returns a zero ratio rather than NaN when nothing was offered', async () => {
    const { prisma, service } = setup({ kind: 'platform' })
    prisma.$queryRaw
      .mockResolvedValueOnce([revenueRow()])
      .mockResolvedValueOnce([occupancyRow(0, 0)])

    const result = await service.summary(platformUser, { from, to })

    expect(result.occupancy.ratio).toBe(0)
  })

  it('restricts offered capacity to facilities the booking path would actually accept', async () => {
    const { prisma, service } = setup({ kind: 'platform' })
    prisma.$queryRaw
      .mockResolvedValueOnce([revenueRow()])
      .mockResolvedValueOnce([occupancyRow(0, 0)])

    await service.summary(platformUser, { from, to })

    const occupancy = sqlOf(prisma.$queryRaw.mock.calls[1]!)
    expect(occupancy.text).toContain('f."isActive"')
    expect(occupancy.text).toContain('f."isPublished"')
    expect(occupancy.text).toContain('f."kind"')
    expect(occupancy.values).toContain('BUSINESS')
  })
})

describe('AnalyticsService revenue series', () => {
  it('returns one zero-filled point per bucket with no nulls', async () => {
    const { prisma, service } = setup({ kind: 'platform' })
    prisma.$queryRaw.mockResolvedValueOnce([
      {
        bucket_start: new Date('2026-07-01T00:00:00Z'),
        currency: null,
        gross_cents: BigInt(0),
        refunded_cents: BigInt(0),
        booking_count: 0,
      },
      {
        bucket_start: new Date('2026-07-02T00:00:00Z'),
        currency: 'EUR',
        gross_cents: BigInt(5_000),
        refunded_cents: BigInt(500),
        booking_count: 2,
      },
    ])

    const result = await service.revenueSeries(platformUser, { from, to, bucket: 'day' })

    expect(result.bucket).toBe('day')
    expect(result.currency).toBe('EUR')
    expect(result.points).toEqual([
      {
        bucketStart: new Date('2026-07-01T00:00:00Z'),
        grossRevenueCents: 0,
        refundedCents: 0,
        netRevenueCents: 0,
        bookingCount: 0,
      },
      {
        bucketStart: new Date('2026-07-02T00:00:00Z'),
        grossRevenueCents: 5_000,
        refundedCents: 500,
        netRevenueCents: 4_500,
        bookingCount: 2,
      },
    ])
    expect(sqlOf(prisma.$queryRaw.mock.calls[0]!).text).toContain('generate_series')
  })

  it('defaults an entirely empty series to the schema currency', async () => {
    const { prisma, service } = setup({ kind: 'platform' })
    prisma.$queryRaw.mockResolvedValueOnce([])

    const result = await service.revenueSeries(platformUser, { from, to, bucket: 'month' })

    expect(result.currency).toBe('EUR')
    expect(result.points).toEqual([])
  })
})

describe('AnalyticsService advanced analytics gate', () => {
  const scoped = { kind: 'operator', operatorIds: ['op-a'] } as OperatorScope

  it('refuses an operator whose plan does not include analytics.advanced', async () => {
    const { service, entitlements, prisma } = setup(scoped, false)

    await expect(service.advancedSummary(operatorUser, { from, to })).rejects.toBeInstanceOf(
      SubscriptionFeatureRequiredError,
    )
    expect(entitlements.hasFeature).toHaveBeenCalledWith('op-a', 'analytics.advanced')
    expect(prisma.$queryRaw).not.toHaveBeenCalled()
  })

  // The basic panel is what an operator runs their business on; losing it with a plan would
  // be a support ticket, not an upsell.
  it('leaves the basic summary working for that same operator', async () => {
    const { service } = setup(scoped, false)

    await expect(service.summary(operatorUser, { from, to })).resolves.toMatchObject({
      currency: 'EUR',
    })
  })

  it('compares the range against the equal-length one before it', async () => {
    const { service, prisma } = setup(scoped)
    prisma.$queryRaw
      .mockResolvedValueOnce([revenueRow()])
      .mockResolvedValueOnce([occupancyRow(50, 100)])
      .mockResolvedValueOnce([revenueRow({ gross_cents: BigInt(4_000), booking_count: 1 })])
      .mockResolvedValueOnce([occupancyRow(25, 100)])

    const result = await service.advancedSummary(operatorUser, { from, to })

    expect(result.current.netRevenueCents).toBe(10_000)
    expect(result.previous.netRevenueCents).toBe(4_000)
    expect(result.netRevenueDeltaCents).toBe(6_000)
    expect(result.bookingCountDelta).toBe(3)
    expect(result.occupancyRatioDelta).toBe(0.25)
    // Same length as the reported range, ending where it begins.
    expect(result.previous.range).toEqual({ from: new Date('2026-05-31T00:00:00Z'), to: from })
  })

  // A platform-wide view is nobody's tenancy, so there is no plan to consult.
  it('does not gate an unscoped platform caller', async () => {
    const { service, entitlements } = setup({ kind: 'platform' }, false)

    await expect(service.advancedSummary(platformUser, { from, to })).resolves.toBeDefined()
    expect(entitlements.hasFeature).not.toHaveBeenCalled()
  })
})
