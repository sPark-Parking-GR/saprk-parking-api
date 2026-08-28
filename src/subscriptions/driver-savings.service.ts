import { Injectable, Logger } from '@nestjs/common'
import { BookingStatus, LifecycleStatus } from '@prisma/client'
import { NotificationsService } from '../notifications/notifications.service'
import { PrismaService } from '../prisma/prisma.service'
import { LIVE_SUBSCRIPTION_STATUSES } from './subscriptions.constants'

export const SAVINGS_WINDOW_DAYS = 30

const WINDOW_MS = SAVINGS_WINDOW_DAYS * 24 * 60 * 60 * 1000

export const SAVINGS_SUMMARY_AUDIT_ACTION = 'driver_subscription.savings_summary_sent'

const SAVINGS_SUMMARY_ENTITY_TYPE = 'User'

/**
 * A stay the rider actually got. CONFIRMED and CHECKED_IN are included alongside CHECKED_OUT
 * because the money moved at confirm — the discount was applied to a price that was charged,
 * whether or not the barrier has since read the ticket. Everything else is excluded for a
 * reason of its own: PENDING_PAYMENT and EXPIRED never took a payment at all, CANCELLED
 * unwound one, and REFUND_PENDING/REFUNDED are money on its way back — telling someone they
 * "saved" on a booking they are being refunded for is worse than telling them nothing.
 */
const COUNTED_STATUSES = [
  BookingStatus.CONFIRMED,
  BookingStatus.CHECKED_IN,
  BookingStatus.CHECKED_OUT,
] as const

export interface SavingsPeriod {
  start: Date
  end: Date
}

export interface RiderSavings {
  userId: string
  savedCents: number
  currency: string
}

export interface SavingsSummaryRun {
  periodStart: Date
  periodEnd: Date
  candidates: number
  sent: number
  alreadySummarised: number
  unreachable: number
  mixedCurrency: number
  failed: number
}

/**
 * The driver-side value nudge: "you saved €X this month".
 *
 * WHY IT LIVES IN THE SUBSCRIPTIONS MODULE RATHER THAN THE BOOKING ONE. It reads Booking
 * rows, but a booking is only ever the evidence here — the subject is what a rider's plan is
 * worth to them. Everything else about it belongs to this domain: the figure exists only
 * because a DriverSubscription granted `bookingDiscountBps`, the plan name is read off that
 * subscription, and the audit trail is filed under `driver_subscription.*` next to the other
 * events in the rider's billing life. Putting it in BookingModule would drag notifications
 * and driver-plan lookups into the module that sells parking, to service a concern that
 * module has no stake in.
 *
 * WHY NOT ON DriverEntitlementService. That service answers "what does this rider have a
 * right to, right now" from the subscription alone, with no history and no side effects — it
 * sits on the booking-quote hot path and is deliberately one query wide. This is a
 * retrospective aggregate that sends email and writes audit rows; folding it in would make
 * the entitlement resolver a thing you cannot call without thinking about mail.
 */
@Injectable()
export class DriverSavingsService {
  private readonly logger = new Logger(DriverSavingsService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * The trailing window ending at `now`. Anchored on the clock rather than on calendar
   * months so the sweep can run on any day and still cover a whole period — a calendar month
   * would leave whatever happened between the 1st and the run either double-counted or lost,
   * depending on which side of the boundary the job woke up.
   */
  periodFor(now: Date): SavingsPeriod {
    return { start: new Date(now.getTime() - WINDOW_MS), end: now }
  }

  /**
   * What one rider saved in the window. `discountCents > 0` rather than `not: null` is what
   * keeps pre-migration rows (NULL, meaning "unknown", see 20260827400000) from being read as
   * zeros and what makes the sum a floor rather than a guess.
   */
  async sumForRider(userId: string, period: SavingsPeriod): Promise<number> {
    const result = await this.prisma.booking.aggregate({
      where: {
        userId,
        status: { in: [...COUNTED_STATUSES] },
        startsAt: { gte: period.start, lt: period.end },
        discountCents: { gt: 0 },
      },
      _sum: { discountCents: true },
    })

    return result._sum.discountCents ?? 0
  }

  /**
   * Every rider with something to report, one row each.
   *
   * The window is measured on `startsAt`, not `createdAt`: "you saved this month" is a claim
   * about parking the rider actually did, and a stay booked in March for a July weekend is a
   * July saving to the person who parked.
   *
   * No `having` clause is needed — the `> 0` filter is applied per row, so every group that
   * survives it sums to more than zero by construction.
   *
   * Grouping by currency as well as rider is not defensive: Booking.currency comes from the
   * tariff plan, so a rider who parks under two operators priced in different currencies has
   * two incomparable totals. Those riders are reported here and dropped by the caller rather
   * than summed into a number that would be arithmetic on unlike units.
   */
  async findRidersWithSavings(period: SavingsPeriod): Promise<RiderSavings[]> {
    const grouped = await this.prisma.booking.groupBy({
      by: ['userId', 'currency'],
      where: {
        status: { in: [...COUNTED_STATUSES] },
        startsAt: { gte: period.start, lt: period.end },
        discountCents: { gt: 0 },
      },
      _sum: { discountCents: true },
    })

    return grouped.map((row) => ({
      userId: row.userId,
      currency: row.currency,
      savedCents: row._sum.discountCents ?? 0,
    }))
  }

  /**
   * One sweep. Safe to run on any cadence at least as tight as the window: the per-rider
   * dedup below, not the scheduler, is what decides who actually gets mail.
   */
  async sendSavingsSummaries(now: Date = new Date()): Promise<SavingsSummaryRun> {
    const period = this.periodFor(now)
    const rows = await this.findRidersWithSavings(period)

    const byRider = new Map<string, RiderSavings[]>()
    for (const row of rows) {
      byRider.set(row.userId, [...(byRider.get(row.userId) ?? []), row])
    }

    const run: SavingsSummaryRun = {
      periodStart: period.start,
      periodEnd: period.end,
      candidates: byRider.size,
      sent: 0,
      alreadySummarised: 0,
      unreachable: 0,
      mixedCurrency: 0,
      failed: 0,
    }

    if (byRider.size === 0) return run

    const riderIds = [...byRider.keys()]
    const [summarised, recipients, subscriptions] = await Promise.all([
      this.alreadySummarised(riderIds, period),
      this.reachableRecipients(riderIds),
      this.livePlanNames(riderIds),
    ])

    for (const [userId, totals] of byRider) {
      if (summarised.has(userId)) {
        run.alreadySummarised++
        continue
      }

      if (totals.length > 1) {
        // Reconciliation case, not a rounding problem: the same refusal to invent a figure
        // that makes BookingService keep the quoted price on a currency mismatch at
        // check-out rather than bill a number nobody agreed to.
        this.logger.warn(
          `Rider ${userId} saved in ${totals.length} currencies this period; no summary sent`,
        )
        run.mixedCurrency++
        continue
      }

      const recipient = recipients.get(userId)
      if (!recipient) {
        run.unreachable++
        continue
      }

      const total = totals[0]!
      const delivered = await this.notifications.sendDriverSavingsSummary({
        to: recipient.email,
        riderName: recipient.displayName,
        savedCents: total.savedCents,
        currency: total.currency,
        planName: subscriptions.get(userId) ?? null,
        periodStart: period.start,
        periodEnd: period.end,
      })

      if (!delivered) {
        // No audit row, so the next sweep retries. NotificationsService has already logged
        // the cause with the address redacted.
        run.failed++
        continue
      }

      await this.recordSummarySent(userId, total.savedCents, period)
      run.sent++
    }

    return run
  }

  /**
   * Riders whose last summary still overlaps this window.
   *
   * `createdAt >= period.start` IS the overlap test, not an approximation of one. Every run
   * summarises a window of exactly SAVINGS_WINDOW_DAYS ending at the moment it runs, so a row
   * written at time t covers [t - window, t]; that interval intersects [now - window, now]
   * precisely when t > now - window. Comparing the stored payload instead would mean JSON
   * date-string comparisons for an answer the row's own timestamp already gives exactly.
   */
  private async alreadySummarised(
    riderIds: string[],
    period: SavingsPeriod,
  ): Promise<Set<string>> {
    const rows = await this.prisma.auditLog.findMany({
      where: {
        action: SAVINGS_SUMMARY_AUDIT_ACTION,
        entityType: SAVINGS_SUMMARY_ENTITY_TYPE,
        entityId: { in: riderIds },
        createdAt: { gte: period.start },
      },
      select: { entityId: true },
    })

    return new Set(rows.map((row) => row.entityId))
  }

  /**
   * Who may actually be mailed. A tombstoned account's `email` has been rewritten by
   * AccountDeletionService and belongs to nobody, and anything past ACTIVE in the lifecycle
   * is an account an administrator has taken out of service — sending either one an upsell
   * would be mailing a person who asked to be gone.
   */
  private async reachableRecipients(
    riderIds: string[],
  ): Promise<Map<string, { email: string; displayName: string | null }>> {
    const users = await this.prisma.user.findMany({
      where: {
        id: { in: riderIds },
        deletedAt: null,
        lifecycleStatus: LifecycleStatus.ACTIVE,
      },
      select: { id: true, email: true, displayName: true },
    })

    return new Map(users.map((user) => [user.id, { email: user.email, displayName: user.displayName }]))
  }

  /**
   * The plan each rider is on today, for the line that names it. Absent for a rider whose
   * subscription lapsed inside the window — they still saved the money, and the email says so
   * without claiming they are still subscribed.
   */
  private async livePlanNames(riderIds: string[]): Promise<Map<string, string>> {
    const subscriptions = await this.prisma.driverSubscription.findMany({
      where: { userId: { in: riderIds }, status: { in: [...LIVE_SUBSCRIPTION_STATUSES] } },
      select: { userId: true, plan: { select: { name: true } } },
    })

    return new Map(subscriptions.map((row) => [row.userId, row.plan.name]))
  }

  /**
   * Written after delivery, not before. The two failure modes are not symmetric: recording
   * first and failing to send costs the rider their one nudge for the whole window with
   * nothing to retry from, while sending first and failing to record costs at most one
   * duplicate on the next sweep. Only one of those is recoverable.
   */
  private async recordSummarySent(
    userId: string,
    savedCents: number,
    period: SavingsPeriod,
  ): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        action: SAVINGS_SUMMARY_AUDIT_ACTION,
        entityType: SAVINGS_SUMMARY_ENTITY_TYPE,
        entityId: userId,
        payload: {
          periodStart: period.start.toISOString(),
          periodEnd: period.end.toISOString(),
          savedCents,
        },
      },
    })
  }
}
