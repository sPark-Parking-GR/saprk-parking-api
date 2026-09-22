import {
  BookingStatus,
  FacilityKind,
  IngestSource,
  PaymentStatus,
  Prisma,
  RefundStatus,
  UserRole,
} from '@prisma/client'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import type { AuthUser } from '@spark/types'
import { AnalyticsService } from '../../src/analytics/analytics.service'
import { MixedCurrencyAnalyticsError } from '../../src/common/errors/domain.errors'
import { FacilitiesService } from '../../src/facilities/facilities.service'
import { UNCLAIMED_OPERATOR_ID } from '../../src/ingestion/ingestion.constants'
import { PromotionService } from '../../src/ingestion/promotion.service'
import type { PrismaService } from '../../src/prisma/prisma.service'
import { authUser } from '../utils/auth'
import { truncateAll } from '../utils/db'
import {
  seedBooking,
  seedFacility,
  seedOperator,
  seedOwnership,
  seedPayment,
  seedRefund,
  seedUser,
} from '../utils/seed'
import { createTestApp } from '../utils/test-app'

const FROM = new Date('2026-06-01T00:00:00.000Z')
const TO = new Date('2026-06-08T00:00:00.000Z')
const OWNED_SINCE = new Date('2026-01-01T00:00:00.000Z')

function day(offset: number, hour = 12): Date {
  return new Date(Date.UTC(2026, 5, 1 + offset, hour))
}

describe('analytics (e2e)', () => {
  let app: NestFastifyApplication
  let prisma: PrismaService
  let analytics: AnalyticsService
  let facilities: FacilitiesService

  beforeAll(async () => {
    const testApp = await createTestApp()
    app = testApp.app
    prisma = testApp.prisma
    analytics = app.get(AnalyticsService)
    facilities = app.get(FacilitiesService)
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(async () => {
    await truncateAll(prisma)
    // truncateAll takes the migration-seeded Starter plan with it, and the create path
    // resolves entitlements before it writes. Without this, the one test that creates a
    // facility through the service fails closed on a missing default plan.
  })

  /** One operator that owns one facility outright, plus a caller scoped to it. */
  async function ownedFacility(options: { onlineQuota?: number; name?: string } = {}) {
    const operator = await seedOperator(prisma)
    const facility = await seedFacility(prisma, {
      operatorId: operator.id,
      lat: 37.9838,
      lng: 23.7275,
      onlineQuota: options.onlineQuota ?? 10,
      ...(options.name ? { name: options.name } : {}),
    })
    await seedOwnership(prisma, {
      facilityId: facility.id,
      operatorId: operator.id,
      from: OWNED_SINCE,
    })
    const staff = await seedUser(prisma, {
      role: UserRole.OPERATOR_ADMIN,
      operatorId: operator.id,
    })

    return { operator, facility, caller: authUser(staff) }
  }

  async function settledBooking(options: {
    facilityId: string
    amountCents: number
    settledAt: Date
    status?: PaymentStatus
    currency?: string
    startsAt?: Date
    endsAt?: Date
  }) {
    const user = await seedUser(prisma)
    const booking = await seedBooking(prisma, {
      facilityId: options.facilityId,
      userId: user.id,
      startsAt: options.startsAt ?? day(1, 10),
      endsAt: options.endsAt ?? day(1, 12),
      status: BookingStatus.CONFIRMED,
      quotedPriceCents: options.amountCents,
      ...(options.currency ? { currency: options.currency } : {}),
    })
    const payment = await seedPayment(prisma, {
      bookingId: booking.id,
      amountCents: options.amountCents,
      createdAt: options.settledAt,
      ...(options.status ? { status: options.status } : {}),
      ...(options.currency ? { currency: options.currency } : {}),
    })

    return { booking, payment }
  }

  describe('revenue', () => {
    it('nets gross against successful refunds', async () => {
      const { facility, caller } = await ownedFacility()

      await settledBooking({
        facilityId: facility.id,
        amountCents: 5_000,
        settledAt: day(1),
      })
      const partial = await settledBooking({
        facilityId: facility.id,
        amountCents: 3_000,
        settledAt: day(2),
        status: PaymentStatus.PARTIALLY_REFUNDED,
      })
      await seedRefund(prisma, {
        bookingId: partial.booking.id,
        paymentId: partial.payment.id,
        amountCents: 1_200,
      })

      const summary = await analytics.summary(caller, { from: FROM, to: TO })

      expect(summary).toMatchObject({
        currency: 'EUR',
        grossRevenueCents: 8_000,
        refundedCents: 1_200,
        netRevenueCents: 6_800,
        bookingCount: 2,
        averageTicketCents: 3_400,
      })
    })

    it('nets a fully refunded booking to zero and drops it from the booking count', async () => {
      const { facility, caller } = await ownedFacility()

      const refunded = await settledBooking({
        facilityId: facility.id,
        amountCents: 4_500,
        settledAt: day(1),
        status: PaymentStatus.REFUNDED,
      })
      await seedRefund(prisma, {
        bookingId: refunded.booking.id,
        paymentId: refunded.payment.id,
        amountCents: 4_500,
      })

      const summary = await analytics.summary(caller, { from: FROM, to: TO })

      expect(summary).toMatchObject({
        grossRevenueCents: 4_500,
        refundedCents: 4_500,
        netRevenueCents: 0,
        bookingCount: 0,
        averageTicketCents: 0,
      })
    })

    it('ignores unsettled payments and unsuccessful refunds', async () => {
      const { facility, caller } = await ownedFacility()

      await settledBooking({
        facilityId: facility.id,
        amountCents: 2_000,
        settledAt: day(1),
      })
      await settledBooking({
        facilityId: facility.id,
        amountCents: 9_999,
        settledAt: day(2),
        status: PaymentStatus.PENDING,
      })
      await settledBooking({
        facilityId: facility.id,
        amountCents: 8_888,
        settledAt: day(3),
        status: PaymentStatus.FAILED,
      })
      const withFailedRefund = await settledBooking({
        facilityId: facility.id,
        amountCents: 1_000,
        settledAt: day(4),
      })
      await seedRefund(prisma, {
        bookingId: withFailedRefund.booking.id,
        paymentId: withFailedRefund.payment.id,
        amountCents: 1_000,
        status: RefundStatus.FAILED,
      })

      const summary = await analytics.summary(caller, { from: FROM, to: TO })

      expect(summary).toMatchObject({
        grossRevenueCents: 3_000,
        refundedCents: 0,
        netRevenueCents: 3_000,
        bookingCount: 2,
      })
    })

    it('excludes payments settled outside the half-open range', async () => {
      const { facility, caller } = await ownedFacility()

      await settledBooking({
        facilityId: facility.id,
        amountCents: 100,
        settledAt: new Date(FROM.getTime() - 1),
      })
      await settledBooking({ facilityId: facility.id, amountCents: 200, settledAt: FROM })
      await settledBooking({ facilityId: facility.id, amountCents: 400, settledAt: TO })

      const summary = await analytics.summary(caller, { from: FROM, to: TO })

      expect(summary.grossRevenueCents).toBe(200)
    })

    it('refuses to sum minor units of different currencies', async () => {
      const { facility, caller } = await ownedFacility()

      await settledBooking({ facilityId: facility.id, amountCents: 1_000, settledAt: day(1) })
      await settledBooking({
        facilityId: facility.id,
        amountCents: 2_000,
        settledAt: day(2),
        currency: 'GBP',
      })

      await expect(analytics.summary(caller, { from: FROM, to: TO })).rejects.toBeInstanceOf(
        MixedCurrencyAnalyticsError,
      )
    })
  })

  describe('revenue series', () => {
    it('zero-fills every bucket in the range, leaving no gaps', async () => {
      const { facility, caller } = await ownedFacility()

      await settledBooking({ facilityId: facility.id, amountCents: 1_500, settledAt: day(0) })
      await settledBooking({ facilityId: facility.id, amountCents: 2_500, settledAt: day(4) })

      const series = await analytics.revenueSeries(caller, {
        from: FROM,
        to: TO,
        bucket: 'day',
      })

      expect(series.points).toHaveLength(7)
      expect(series.points.map((point) => point.bucketStart.toISOString())).toEqual([
        '2026-06-01T00:00:00.000Z',
        '2026-06-02T00:00:00.000Z',
        '2026-06-03T00:00:00.000Z',
        '2026-06-04T00:00:00.000Z',
        '2026-06-05T00:00:00.000Z',
        '2026-06-06T00:00:00.000Z',
        '2026-06-07T00:00:00.000Z',
      ])
      expect(series.points.map((point) => point.netRevenueCents)).toEqual([
        1_500, 0, 0, 0, 2_500, 0, 0,
      ])
      expect(series.points.reduce((sum, point) => sum + point.netRevenueCents, 0)).toBe(4_000)
    })

    it('produces a single zero bucket for a range with no money at all', async () => {
      const { caller } = await ownedFacility()

      const series = await analytics.revenueSeries(caller, {
        from: FROM,
        to: new Date('2026-06-02T00:00:00.000Z'),
        bucket: 'day',
      })

      expect(series.currency).toBe('EUR')
      expect(series.points).toEqual([
        {
          bucketStart: FROM,
          grossRevenueCents: 0,
          refundedCents: 0,
          netRevenueCents: 0,
          bookingCount: 0,
        },
      ])
    })

    it('buckets by week without dropping a payment', async () => {
      const { facility, caller } = await ownedFacility()

      await settledBooking({ facilityId: facility.id, amountCents: 700, settledAt: day(0) })
      await settledBooking({ facilityId: facility.id, amountCents: 300, settledAt: day(6) })

      const series = await analytics.revenueSeries(caller, {
        from: FROM,
        to: TO,
        bucket: 'week',
      })

      expect(series.points.reduce((sum, point) => sum + point.grossRevenueCents, 0)).toBe(1_000)
    })
  })

  describe('ownership attribution', () => {
    /**
     * The facility's CURRENT owner is the incoming operator; the payment settled while the
     * outgoing one still held it. Attributing through Facility.operatorId would hand the
     * money to the wrong operator, so this is the assertion the whole module exists for.
     */
    async function reassignedFacility() {
      const [outgoing, incoming] = await Promise.all([seedOperator(prisma), seedOperator(prisma)])
      const handover = day(3, 0)

      const facility = await seedFacility(prisma, {
        operatorId: incoming.id,
        lat: 37.9838,
        lng: 23.7275,
        name: 'Reassigned park',
      })

      await seedOwnership(prisma, {
        facilityId: facility.id,
        operatorId: outgoing.id,
        from: OWNED_SINCE,
        to: handover,
      })
      await seedOwnership(prisma, {
        facilityId: facility.id,
        operatorId: incoming.id,
        from: handover,
      })

      const [outgoingUser, incomingUser] = await Promise.all([
        seedUser(prisma, { role: UserRole.OPERATOR_ADMIN, operatorId: outgoing.id }),
        seedUser(prisma, { role: UserRole.OPERATOR_ADMIN, operatorId: incoming.id }),
      ])

      // Settles the day BEFORE the handover: the outgoing operator's money.
      await settledBooking({ facilityId: facility.id, amountCents: 6_000, settledAt: day(2) })
      // Settles after it: the incoming operator's.
      await settledBooking({ facilityId: facility.id, amountCents: 1_000, settledAt: day(5) })

      return {
        facility,
        outgoing,
        incoming,
        outgoingCaller: authUser(outgoingUser),
        incomingCaller: authUser(incomingUser),
      }
    }

    it('credits the period owner at settlement, not the facility owner today', async () => {
      const { outgoingCaller, incomingCaller } = await reassignedFacility()

      const [outgoingSummary, incomingSummary] = await Promise.all([
        analytics.summary(outgoingCaller, { from: FROM, to: TO }),
        analytics.summary(incomingCaller, { from: FROM, to: TO }),
      ])

      expect(outgoingSummary.netRevenueCents).toBe(6_000)
      expect(incomingSummary.netRevenueCents).toBe(1_000)
    })

    it('splits a reassigned facility into one top-facilities row per period owner', async () => {
      const { facility, outgoing, incoming } = await reassignedFacility()
      const platformUser = await seedUser(prisma, { role: UserRole.PLATFORM_ADMIN })

      const top = await analytics.topFacilities(authUser(platformUser), {
        from: FROM,
        to: TO,
        limit: 10,
      })

      expect(top.items).toHaveLength(2)
      expect(top.items.map((item) => [item.operatorId, item.netRevenueCents])).toEqual([
        [outgoing.id, 6_000],
        [incoming.id, 1_000],
      ])
      expect(new Set(top.items.map((item) => item.facilityId))).toEqual(new Set([facility.id]))
    })

    /**
     * Regression. `FacilityOwnershipPeriod` is read by every analytics query, and the
     * attribution join is `JOIN LATERAL (...) ON TRUE` — an INNER join. A facility created
     * without a period therefore takes money that revenue, top-facilities and occupancy all
     * silently omit, so the create path must open one in the same transaction.
     *
     * The range hangs off `facility.createdAt` rather than the fixed June window every other
     * test uses: the period opens the instant the facility does, and money it took before it
     * existed is not a case that can occur.
     */
    it('reports revenue for a facility created through the API', async () => {
      const operator = await seedOperator(prisma)
      const admin = await seedUser(prisma, { role: UserRole.PLATFORM_ADMIN })

      const facility = await facilities.create(authUser(admin), {
        name: 'Created through the service',
        address: '2 Test Street',
        lat: 37.9838,
        lng: 23.7275,
        totalCapacity: 50,
        onlineQuota: 10,
        vehicleTypes: ['car'],
        openingHours: { is24h: true },
        amenities: [],
        cancellationPolicy: '',
        operatorId: operator.id,
      })

      const settledAt = new Date(facility.createdAt.getTime() + 1_000)
      await settledBooking({ facilityId: facility.id, amountCents: 7_700, settledAt })

      const summary = await analytics.summary(authUser(admin), {
        from: facility.createdAt,
        to: new Date(facility.createdAt.getTime() + 60_000),
      })

      expect(summary.grossRevenueCents).toBe(7_700)
    })

    /**
     * The other creation path, and the one the unit suite cannot speak for: ingestion
     * promotes a RawPlace under the synthetic unclaimed-import operator. An import takes no
     * money while unclaimed, but the period is what makes it countable the moment it is
     * claimed, so the invariant has to hold here too.
     *
     * PromotionService is constructed directly because createTestApp replaces
     * IngestionModule with an empty one to keep BullMQ workers out of the suite.
     */
    it('opens an ownership period for a facility created by ingestion promotion', async () => {
      const promotion = new PromotionService(prisma)

      await prisma.rawPlace.create({
        data: {
          source: IngestSource.OSM,
          sourceRef: 'node/424242',
          sourceType: 'node',
          raw: { tags: { name: 'Imported Lot', amenity: 'parking', capacity: '40' } },
          lat: new Prisma.Decimal(37.9838),
          lng: new Prisma.Decimal(23.7275),
          contentHash: 'hash-e2e-424242',
        },
      })

      await expect(promotion.drainPending()).resolves.toMatchObject({ created: 1 })

      const facility = await prisma.facility.findFirstOrThrow({
        where: { sourceRef: 'node/424242' },
      })
      const periods = await prisma.facilityOwnershipPeriod.findMany({
        where: { facilityId: facility.id },
      })

      expect(periods).toHaveLength(1)
      expect(periods[0]).toMatchObject({ operatorId: UNCLAIMED_OPERATOR_ID, to: null })
      expect(periods[0]?.from).toEqual(facility.createdAt)

      const admin = await seedUser(prisma, { role: UserRole.PLATFORM_ADMIN })
      const settledAt = new Date(facility.createdAt.getTime() + 1_000)
      await settledBooking({ facilityId: facility.id, amountCents: 4_242, settledAt })

      const summary = await analytics.summary(authUser(admin), {
        from: facility.createdAt,
        to: new Date(facility.createdAt.getTime() + 60_000),
      })

      expect(summary.grossRevenueCents).toBe(4_242)
    })
  })

  describe('occupancy', () => {
    it('measures booked slot-minutes against the quota offered over the owned window', async () => {
      const { facility, caller } = await ownedFacility({ onlineQuota: 10 })
      const user = await seedUser(prisma)

      await seedBooking(prisma, {
        facilityId: facility.id,
        userId: user.id,
        startsAt: day(1, 10),
        endsAt: day(1, 12),
        status: BookingStatus.CHECKED_OUT,
      })
      await seedBooking(prisma, {
        facilityId: facility.id,
        userId: user.id,
        startsAt: day(2, 8),
        endsAt: day(2, 9),
        status: BookingStatus.CONFIRMED,
      })
      // Released the slot, so it occupied nothing.
      await seedBooking(prisma, {
        facilityId: facility.id,
        userId: user.id,
        startsAt: day(3, 8),
        endsAt: day(3, 20),
        status: BookingStatus.CANCELLED,
      })

      const { occupancy } = await analytics.summary(caller, { from: FROM, to: TO })

      // 7 days x 1440 minutes x quota 10.
      expect(occupancy.capacitySlotMinutes).toBe(100_800)
      expect(occupancy.bookedSlotMinutes).toBe(180)
      expect(occupancy.ratio).toBeCloseTo(180 / 100_800, 4)
    })

    it('clips a booking that overhangs the range to the reported window', async () => {
      const { facility, caller } = await ownedFacility({ onlineQuota: 1 })
      const user = await seedUser(prisma)

      await seedBooking(prisma, {
        facilityId: facility.id,
        userId: user.id,
        startsAt: new Date('2026-05-31T22:00:00.000Z'),
        endsAt: new Date('2026-06-01T02:00:00.000Z'),
        status: BookingStatus.CHECKED_OUT,
      })

      const { occupancy } = await analytics.summary(caller, { from: FROM, to: TO })

      expect(occupancy.bookedSlotMinutes).toBe(120)
    })

    it('reports zero rather than dividing by an absent capacity', async () => {
      const { caller } = await ownedFacility({ onlineQuota: 0 })

      const { occupancy } = await analytics.summary(caller, { from: FROM, to: TO })

      expect(occupancy).toEqual({
        bookedSlotMinutes: 0,
        capacitySlotMinutes: 0,
        ratio: 0,
      })
    })

    it('excludes a catalog-only facility from capacity even with a large onlineQuota', async () => {
      const { operator, caller } = await ownedFacility({ onlineQuota: 10 })
      const catalogOnly = await seedFacility(prisma, {
        operatorId: operator.id,
        lat: 37.98,
        lng: 23.72,
        onlineQuota: 100_000,
        kind: FacilityKind.FREE_PUBLIC,
      })
      await seedOwnership(prisma, {
        facilityId: catalogOnly.id,
        operatorId: operator.id,
        from: OWNED_SINCE,
      })

      const { occupancy } = await analytics.summary(caller, { from: FROM, to: TO })

      // 7 days x 1440 minutes x quota 10 from the bookable facility only.
      expect(occupancy.capacitySlotMinutes).toBe(100_800)
    })

    it('excludes an unpublished BUSINESS facility from capacity', async () => {
      const { operator, caller } = await ownedFacility({ onlineQuota: 10 })
      const unpublished = await seedFacility(prisma, {
        operatorId: operator.id,
        lat: 37.98,
        lng: 23.72,
        onlineQuota: 50,
        isPublished: false,
      })
      await seedOwnership(prisma, {
        facilityId: unpublished.id,
        operatorId: operator.id,
        from: OWNED_SINCE,
      })

      const { occupancy } = await analytics.summary(caller, { from: FROM, to: TO })

      expect(occupancy.capacitySlotMinutes).toBe(100_800)
    })
  })

  describe('scope', () => {
    it('shows an operator only its own money', async () => {
      const mine = await ownedFacility()
      const theirs = await ownedFacility()

      await settledBooking({ facilityId: mine.facility.id, amountCents: 1_100, settledAt: day(1) })
      await settledBooking({
        facilityId: theirs.facility.id,
        amountCents: 9_900,
        settledAt: day(1),
      })

      const summary = await analytics.summary(mine.caller, { from: FROM, to: TO })

      expect(summary.grossRevenueCents).toBe(1_100)
    })

    it('shows a platform admin every operator, or one when asked', async () => {
      const first = await ownedFacility()
      const second = await ownedFacility()
      const admin = await seedUser(prisma, { role: UserRole.PLATFORM_ADMIN })
      const caller: AuthUser = authUser(admin)

      await settledBooking({ facilityId: first.facility.id, amountCents: 1_100, settledAt: day(1) })
      await settledBooking({
        facilityId: second.facility.id,
        amountCents: 9_900,
        settledAt: day(1),
      })

      const [all, narrowed] = await Promise.all([
        analytics.summary(caller, { from: FROM, to: TO }),
        analytics.summary(caller, { from: FROM, to: TO, operatorId: second.operator.id }),
      ])

      expect(all.grossRevenueCents).toBe(11_000)
      expect(narrowed.grossRevenueCents).toBe(9_900)
    })
  })
})
