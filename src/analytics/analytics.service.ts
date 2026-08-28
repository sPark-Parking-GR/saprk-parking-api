import { Injectable } from '@nestjs/common'
import { BookingStatus, PaymentStatus, Prisma, RefundStatus } from '@prisma/client'
import type { AuthUser } from '@spark/types'
import { OperatorScopeService } from '../common/authz/operator-scope.service'
import {
  AnalyticsScopeForbiddenError,
  MixedCurrencyAnalyticsError,
  SubscriptionFeatureRequiredError,
} from '../common/errors/domain.errors'
import { PrismaService } from '../prisma/prisma.service'
import { EntitlementService } from '../subscriptions/entitlement.service'
import type {
  AnalyticsSummaryDto,
  RevenueBucket,
  RevenueSeriesDto,
  TopFacilitiesDto,
} from './dto/analytics.dto'
import type {
  AnalyticsComparison,
  AnalyticsSummary,
  OccupancySummary,
  RevenuePoint,
  RevenueSeries,
  RevenueTotals,
  TopFacilities,
  TopFacility,
} from './analytics.types'

/**
 * Payments that represent money that actually reached us. A payment row is created
 * PENDING at intent time and only ever leaves that state through a real provider outcome,
 * so PENDING and FAILED are not revenue and never become it retroactively.
 *
 * REFUNDED is included here on purpose even though a fully refunded booking must not count
 * as revenue: it enters `gross` and its refund leaves through `refunded`, so the NET figure
 * — the one the dashboard shows — is exactly zero for it, while the operator can still see
 * the money moved in and back out. Dropping the row entirely would net the same but hide
 * refund volume, which is the number an operator most wants when revenue dips.
 */
const SETTLED_PAYMENT_STATUSES = [
  PaymentStatus.SUCCEEDED,
  PaymentStatus.PARTIALLY_REFUNDED,
  PaymentStatus.REFUNDED,
] as const

/**
 * Bookings that occupied a slot. CHECKED_OUT is in the set although the brief named only
 * CONFIRMED/CHECKED_IN: for any range in the past, every honoured stay has ALREADY been
 * checked out, so excluding it would report near-zero occupancy for precisely the
 * operators who work their barriers properly. CANCELLED/REFUNDED/EXPIRED released the
 * slot and PENDING_PAYMENT is an unconfirmed hold, so none of them occupied anything.
 */
const OCCUPYING_BOOKING_STATUSES = [
  BookingStatus.CONFIRMED,
  BookingStatus.CHECKED_IN,
  BookingStatus.CHECKED_OUT,
] as const

// Matches the schema default on Payment.currency; reported when a range holds no money at
// all, so an empty dashboard shows "€0" rather than a blank.
const DEFAULT_CURRENCY = 'EUR'

const BUCKET_INTERVAL: Record<RevenueBucket, string> = {
  day: '1 day',
  week: '1 week',
  month: '1 month',
}

interface RevenueRow {
  currency: string | null
  gross_cents: bigint
  refunded_cents: bigint
  booking_count: number
}

interface SeriesRow extends RevenueRow {
  bucket_start: Date
}

interface TopFacilityRow extends RevenueRow {
  facility_id: string
  facility_name: string
  operator_id: string
}

interface OccupancyRow {
  booked_minutes: bigint
  capacity_minutes: bigint
}

// Even these fixed enum members travel as bound parameters, so the queries contain no
// interpolated text at all and the rule needs no per-value judgement call.
const SETTLED_STATUS_LIST = Prisma.join(
  SETTLED_PAYMENT_STATUSES.map((status) => Prisma.sql`${status}::"PaymentStatus"`),
)
const OCCUPYING_STATUS_LIST = Prisma.join(
  OCCUPYING_BOOKING_STATUSES.map((status) => Prisma.sql`${status}::"BookingStatus"`),
)

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operatorScope: OperatorScopeService,
    private readonly entitlements: EntitlementService,
  ) {}

  async summary(user: AuthUser, query: AnalyticsSummaryDto): Promise<AnalyticsSummary> {
    const operatorIds = await this.resolveOperatorIds(user, query.operatorId)
    return this.summaryFor(operatorIds, query.from, query.to)
  }

  /**
   * The paid tier of the same panel. The basic summary above is deliberately left ungated —
   * an operator who stops paying for the deeper view must not lose sight of their own
   * revenue, and a metering surface that goes dark is a support ticket, not an upsell.
   */
  async advancedSummary(user: AuthUser, query: AnalyticsSummaryDto): Promise<AnalyticsComparison> {
    const operatorIds = await this.resolveOperatorIds(user, query.operatorId)
    await this.assertAdvancedAnalytics(operatorIds)

    const { from, to } = query
    const previousFrom = new Date(from.getTime() - (to.getTime() - from.getTime()))

    const [current, previous] = await Promise.all([
      this.summaryFor(operatorIds, from, to),
      this.summaryFor(operatorIds, previousFrom, from),
    ])

    return {
      current,
      previous,
      netRevenueDeltaCents: current.netRevenueCents - previous.netRevenueCents,
      bookingCountDelta: current.bookingCount - previous.bookingCount,
      occupancyRatioDelta:
        Math.round((current.occupancy.ratio - previous.occupancy.ratio) * 10_000) / 10_000,
    }
  }

  /**
   * The feature is the TENANT's purchase, so it is checked against the operators being
   * reported on rather than the caller's own role. A platform-wide view (null) belongs to no
   * tenant and is therefore ungated — there is no plan to consult.
   */
  private async assertAdvancedAnalytics(operatorIds: string[] | null): Promise<void> {
    if (operatorIds === null) return

    for (const operatorId of operatorIds) {
      if (!(await this.entitlements.hasFeature(operatorId, 'analytics.advanced'))) {
        throw new SubscriptionFeatureRequiredError('analytics.advanced')
      }
    }
  }

  private async summaryFor(
    operatorIds: string[] | null,
    from: Date,
    to: Date,
  ): Promise<AnalyticsSummary> {
    const [revenueRows, occupancyRows] = await Promise.all([
      this.prisma.$queryRaw<RevenueRow[]>`
        SELECT
          s.currency AS currency,
          COALESCE(SUM(s.gross_cents), 0)::bigint AS gross_cents,
          COALESCE(SUM(s.refunded_cents), 0)::bigint AS refunded_cents,
          COALESCE(SUM(s.paid_booking), 0)::int AS booking_count
        FROM (${this.settledPaymentsSql(from, to, operatorIds)}) s
        GROUP BY s.currency`,
      this.occupancyQuery(from, to, operatorIds),
    ])

    const currency = this.resolveCurrency(revenueRows.map((r) => r.currency))
    const totals = this.totalsOf(revenueRows)

    return {
      range: { from, to },
      currency,
      ...totals,
      // Integer division of two integers, rounded to whole cents: an average is a derived
      // statistic, not a ledger entry, so it is the one place a cent may be rounded away.
      averageTicketCents:
        totals.bookingCount > 0 ? Math.round(totals.netRevenueCents / totals.bookingCount) : 0,
      occupancy: this.occupancyOf(occupancyRows[0]),
    }
  }

  async revenueSeries(user: AuthUser, query: RevenueSeriesDto): Promise<RevenueSeries> {
    const operatorIds = await this.resolveOperatorIds(user, query.operatorId)
    const { from, to, bucket } = query
    const step = BUCKET_INTERVAL[bucket]

    // Buckets come from generate_series and the aggregate is LEFT JOINed onto them, so a
    // period with no money is a zero row rather than a hole the chart has to invent.
    const rows = await this.prisma.$queryRaw<SeriesRow[]>`
      WITH settled AS (${this.settledPaymentsSql(from, to, operatorIds)}),
      agg AS (
        SELECT
          date_trunc(${bucket}::text, s.settled_at) AS bucket_start,
          s.currency AS currency,
          SUM(s.gross_cents) AS gross_cents,
          SUM(s.refunded_cents) AS refunded_cents,
          SUM(s.paid_booking) AS booking_count
        FROM settled s
        GROUP BY 1, 2
      )
      SELECT
        b.bucket_start AS bucket_start,
        a.currency AS currency,
        COALESCE(a.gross_cents, 0)::bigint AS gross_cents,
        COALESCE(a.refunded_cents, 0)::bigint AS refunded_cents,
        COALESCE(a.booking_count, 0)::int AS booking_count
      FROM generate_series(
        date_trunc(${bucket}::text, ${from}::timestamp),
        date_trunc(${bucket}::text, ${to}::timestamp - interval '1 millisecond'),
        ${step}::interval
      ) AS b(bucket_start)
      LEFT JOIN agg a ON a.bucket_start = b.bucket_start
      ORDER BY b.bucket_start ASC`

    const points: RevenuePoint[] = rows.map((row) => ({
      bucketStart: row.bucket_start,
      ...this.totalsOf([row]),
    }))

    return {
      range: { from, to },
      bucket,
      currency: this.resolveCurrency(rows.map((r) => r.currency)),
      points,
    }
  }

  async topFacilities(user: AuthUser, query: TopFacilitiesDto): Promise<TopFacilities> {
    const operatorIds = await this.resolveOperatorIds(user, query.operatorId)
    const { from, to, limit } = query

    // Grouped by the ATTRIBUTED operator as well as the facility: a facility that changed
    // hands mid-range is two rows, one per owner, which is the honest answer — collapsing
    // them would hand one operator the other's money back.
    const rows = await this.prisma.$queryRaw<TopFacilityRow[]>`
      SELECT
        s.facility_id AS facility_id,
        f."name" AS facility_name,
        s.operator_id AS operator_id,
        s.currency AS currency,
        SUM(s.gross_cents)::bigint AS gross_cents,
        SUM(s.refunded_cents)::bigint AS refunded_cents,
        SUM(s.paid_booking)::int AS booking_count
      FROM (${this.settledPaymentsSql(from, to, operatorIds)}) s
      JOIN "Facility" f ON f."id" = s.facility_id
      GROUP BY s.facility_id, f."name", s.operator_id, s.currency
      ORDER BY (SUM(s.gross_cents) - SUM(s.refunded_cents)) DESC, f."name" ASC
      LIMIT ${limit}`

    const items: TopFacility[] = rows.map((row) => ({
      facilityId: row.facility_id,
      facilityName: row.facility_name,
      operatorId: row.operator_id,
      ...this.totalsOf([row]),
    }))

    return {
      range: { from, to },
      currency: this.resolveCurrency(rows.map((r) => r.currency)),
      items,
    }
  }

  /**
   * Every settled payment in the range, already attributed to the operator that owned the
   * facility AT THE SETTLEMENT INSTANT.
   *
   * The ownership join is the point of the whole module. Joining `Facility.operatorId`
   * instead would be one line shorter and would rewrite every historical payout the moment
   * a facility is reassigned, because that column only ever describes the present.
   *
   * The owner is resolved through a LATERAL ... LIMIT 1 rather than a plain join so a
   * malformed pair of overlapping periods can duplicate no payment: at most one period row
   * can ever pair with a payment, so revenue can be wrong-by-attribution but never
   * inflated. Refunds attach through the payment's own unique refund row, so the LEFT JOIN
   * cannot fan out either.
   */
  private settledPaymentsSql(from: Date, to: Date, operatorIds: string[] | null): Prisma.Sql {
    return Prisma.sql`
      SELECT
        p."currency" AS currency,
        p."createdAt" AS settled_at,
        b."facilityId" AS facility_id,
        own."operatorId" AS operator_id,
        p."amountCents" AS gross_cents,
        COALESCE(r."amountCents", 0) AS refunded_cents,
        CASE WHEN p."status" = ${PaymentStatus.REFUNDED}::"PaymentStatus" THEN 0 ELSE 1 END AS paid_booking
      FROM "Payment" p
      JOIN "Booking" b ON b."id" = p."bookingId"
      JOIN LATERAL (
        SELECT o."operatorId"
        FROM "FacilityOwnershipPeriod" o
        WHERE o."facilityId" = b."facilityId"
          AND o."from" <= p."createdAt"
          AND (o."to" IS NULL OR o."to" > p."createdAt")
        ORDER BY o."from" DESC
        LIMIT 1
      ) own ON TRUE
      LEFT JOIN "Refund" r
        ON r."paymentId" = p."id" AND r."status" = ${RefundStatus.SUCCEEDED}::"RefundStatus"
      WHERE p."status" IN (${SETTLED_STATUS_LIST})
        AND p."createdAt" >= ${from}
        AND p."createdAt" < ${to}
        ${this.operatorFilter(Prisma.sql`own."operatorId"`, operatorIds)}`
  }

  /**
   * Occupancy = slot-minutes taken ÷ slot-minutes offered, over the range.
   *
   * The dashboard's old figure was `onlineQuota / totalCapacity`, which is the share of a
   * car park exposed to online booking and says nothing whatsoever about utilisation: a
   * facility that sold nothing all month scored the same as one that sold out. This
   * measures what was actually used against what was actually offered.
   *
   * Both sides are clipped to the ownership window, so an operator is neither credited for
   * a facility's capacity before they owned it nor charged with its idle time.
   */
  private occupancyQuery(
    from: Date,
    to: Date,
    operatorIds: string[] | null,
  ): Promise<OccupancyRow[]> {
    return this.prisma.$queryRaw<OccupancyRow[]>`
      WITH owned AS (
        SELECT
          f."id" AS facility_id,
          f."onlineQuota"::bigint AS quota,
          GREATEST(o."from", ${from}::timestamp) AS win_from,
          LEAST(COALESCE(o."to", ${to}::timestamp), ${to}::timestamp) AS win_to
        FROM "FacilityOwnershipPeriod" o
        JOIN "Facility" f ON f."id" = o."facilityId"
        WHERE o."from" < ${to}::timestamp
          AND (o."to" IS NULL OR o."to" > ${from}::timestamp)
          ${this.operatorFilter(Prisma.sql`o."operatorId"`, operatorIds)}
      ),
      owned_window AS (
        SELECT * FROM owned WHERE win_to > win_from AND quota > 0
      ),
      capacity AS (
        SELECT COALESCE(
          SUM(quota * FLOOR(EXTRACT(EPOCH FROM (win_to - win_from)) / 60)::bigint), 0
        )::bigint AS minutes
        FROM owned_window
      ),
      booked AS (
        SELECT COALESCE(SUM(
          FLOOR(EXTRACT(EPOCH FROM (
            LEAST(b."endsAt", w.win_to) - GREATEST(b."startsAt", w.win_from)
          )) / 60)::bigint
        ), 0)::bigint AS minutes
        FROM "Booking" b
        JOIN owned_window w ON w.facility_id = b."facilityId"
        WHERE b."status" IN (${OCCUPYING_STATUS_LIST})
          AND b."startsAt" < w.win_to
          AND b."endsAt" > w.win_from
      )
      SELECT booked.minutes AS booked_minutes, capacity.minutes AS capacity_minutes
      FROM capacity CROSS JOIN booked`
  }

  /**
   * Which operators the caller may be shown, or null for "every one of them".
   *
   * Service-layer half of the authorization: the controller's role gate says the caller is
   * staff, this decides whose money they are staff OF. A multi-membership operator sees the
   * union of their operators unless they narrow to one they actually belong to.
   */
  private async resolveOperatorIds(
    user: AuthUser,
    requested: string | undefined,
  ): Promise<string[] | null> {
    const scope = await this.operatorScope.resolve(user)

    if (scope.kind === 'platform') return requested ? [requested] : null

    if (requested !== undefined && !scope.operatorIds.includes(requested)) {
      throw new AnalyticsScopeForbiddenError()
    }

    return requested ? [requested] : scope.operatorIds
  }

  // Every caller-influenced value — the ids, both range ends, the bucket and the limit —
  // rides as a bound parameter; nothing reaches SQL as interpolated text. An empty id list
  // cannot come out of OperatorScopeService (it refuses a membership-less caller), so the
  // false predicate is the fail-closed answer to a future caller that does produce one,
  // rather than a Prisma.join crash or, worse, an unfiltered query.
  private operatorFilter(column: Prisma.Sql, operatorIds: string[] | null): Prisma.Sql {
    if (operatorIds === null) return Prisma.empty
    if (operatorIds.length === 0) return Prisma.sql`AND FALSE`
    return Prisma.sql`AND ${column} IN (${Prisma.join(operatorIds)})`
  }

  private totalsOf(rows: RevenueRow[]): RevenueTotals {
    let gross = 0
    let refunded = 0
    let bookingCount = 0

    for (const row of rows) {
      gross += Number(row.gross_cents)
      refunded += Number(row.refunded_cents)
      bookingCount += Number(row.booking_count)
    }

    return {
      grossRevenueCents: gross,
      refundedCents: refunded,
      netRevenueCents: gross - refunded,
      bookingCount,
    }
  }

  private occupancyOf(row: OccupancyRow | undefined): OccupancySummary {
    const bookedSlotMinutes = Number(row?.booked_minutes ?? 0)
    const capacitySlotMinutes = Number(row?.capacity_minutes ?? 0)

    return {
      bookedSlotMinutes,
      capacitySlotMinutes,
      ratio:
        capacitySlotMinutes > 0
          ? Math.round((bookedSlotMinutes / capacitySlotMinutes) * 10_000) / 10_000
          : 0,
    }
  }

  /**
   * Amounts are integer minor units, and minor units of different currencies are not
   * addable. Currency lives on Payment (and Booking/Refund), not on Facility, so a single
   * operator can in principle hold payments in several — the set is refused rather than
   * summed into a number that means nothing.
   */
  private resolveCurrency(currencies: Array<string | null>): string {
    const distinct = [...new Set(currencies.filter((c): c is string => c !== null))].sort()
    if (distinct.length > 1) throw new MixedCurrencyAnalyticsError(distinct)
    return distinct[0] ?? DEFAULT_CURRENCY
  }
}
