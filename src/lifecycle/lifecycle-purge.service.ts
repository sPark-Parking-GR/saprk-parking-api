import { Injectable, Logger } from '@nestjs/common'
import { BookingStatus, LifecycleStatus, Prisma } from '@prisma/client'
import { anyLifecycleStatus } from '../prisma/lifecycle.extension'
import { PrismaService } from '../prisma/prisma.service'

// Rows processed per resource per run. The worker repeats on an interval, so a backlog
// larger than one batch drains across runs instead of holding one job open for hours.
const PURGE_BATCH_SIZE = 100

// Reserved by RFC 2606 — undeliverable, and unique per row. Mirrors the convention in
// AccountDeletionService so a retention purge and a self-service deletion leave the
// same tombstone shape.
const tombstoneEmail = (userId: string): string => `deleted+${userId}@deleted.invalid`

const FK_RESTRICTED = 'P2003'
const ROW_GONE = 'P2025'

export interface PurgeCounts {
  purged: number
  blocked: number
}

export interface PurgeSummary {
  facilities: PurgeCounts
  tariffPlans: PurgeCounts
  operators: PurgeCounts
  users: PurgeCounts
}

export function emptySummary(): PurgeSummary {
  return {
    facilities: { purged: 0, blocked: 0 },
    tariffPlans: { purged: 0, blocked: 0 },
    operators: { purged: 0, blocked: 0 },
    users: { purged: 0, blocked: 0 },
  }
}

/**
 * Physically removes TOMBSTONED rows whose retention window has lapsed. What "purge"
 * means differs per resource, dictated by referential reality:
 *
 * - Facility: DELETE, but only when no Booking references it — Booking.facilityId is
 *   ON DELETE RESTRICT by design, so a facility with financial history is retained as a
 *   tombstone forever and is never even attempted.
 * - TariffPlan: DELETE. Its schedule cascades and Booking pins plans by (id, version)
 *   value, deliberately not by FK, so nothing blocks. A purged plan makes stale pricing
 *   pins unresolvable, which the pinned-pricing path already reports as null.
 * - ParkingOperator: DELETE only when no Facility (in ANY lifecycle state), no
 *   FacilityOwnershipPeriod and no PromotionPlan references it — all RESTRICT.
 * - User: ANONYMISATION, never deletion. Booking.userId is RESTRICT and bookings carry
 *   payments and refunds. The recipe mirrors AccountDeletionService exactly; it is not
 *   called directly because that method is inseparable from self-service proof of
 *   person (a password sign-in plus the caller's own access token), which an
 *   admin-driven retention purge cannot supply. The row ends PURGED — terminal, out of
 *   the worker's queue, and refused by restore.
 *
 * Idempotent and resumable by construction: eligibility is read from row state on every
 * run, each row is processed in its own transaction, deletion removes the row from the
 * queue, anonymisation moves it to PURGED, and blocked or failed rows are simply
 * re-inspected next run. A crash mid-batch loses nothing.
 */
@Injectable()
export class LifecyclePurgeService {
  private readonly logger = new Logger(LifecyclePurgeService.name)

  constructor(private readonly prisma: PrismaService) {}

  async purgeDue(now: Date = new Date()): Promise<PurgeSummary> {
    const summary = emptySummary()
    summary.facilities = await this.purgeFacilities(now)
    summary.tariffPlans = await this.purgeTariffPlans(now)
    summary.operators = await this.purgeOperators(now)
    summary.users = await this.purgeUsers(now)
    return summary
  }

  private async purgeFacilities(now: Date): Promise<PurgeCounts> {
    const counts: PurgeCounts = { purged: 0, blocked: 0 }
    const due = await this.due(this.prisma.facility, now)

    for (const { id } of due) {
      const bookings = await this.prisma.booking.count({ where: { facilityId: id } })
      if (bookings > 0) {
        counts.blocked++
        continue
      }
      const outcome = await this.tryPurge('Facility', id, async (tx) => {
        await tx.facility.delete({ where: { id, lifecycleStatus: LifecycleStatus.TOMBSTONED } })
      })
      counts[outcome]++
    }
    return counts
  }

  private async purgeTariffPlans(now: Date): Promise<PurgeCounts> {
    const counts: PurgeCounts = { purged: 0, blocked: 0 }
    const due = await this.due(this.prisma.tariffPlan, now)

    for (const { id } of due) {
      const outcome = await this.tryPurge('TariffPlan', id, async (tx) => {
        await tx.tariffPlan.delete({ where: { id, lifecycleStatus: LifecycleStatus.TOMBSTONED } })
      })
      counts[outcome]++
    }
    return counts
  }

  private async purgeOperators(now: Date): Promise<PurgeCounts> {
    const counts: PurgeCounts = { purged: 0, blocked: 0 }
    const due = await this.due(this.prisma.parkingOperator, now)

    for (const { id } of due) {
      // The facility count must see EVERY lifecycle state: a tombstoned facility still
      // physically references its operator, and the default filter would hide it.
      const [facilities, ownershipPeriods, promotionPlans] = await Promise.all([
        this.prisma.facility.count({
          where: { operatorId: id, lifecycleStatus: anyLifecycleStatus() },
        }),
        this.prisma.facilityOwnershipPeriod.count({ where: { operatorId: id } }),
        this.prisma.promotionPlan.count({ where: { operatorId: id } }),
      ])
      if (facilities > 0 || ownershipPeriods > 0 || promotionPlans > 0) {
        counts.blocked++
        continue
      }
      const outcome = await this.tryPurge('ParkingOperator', id, async (tx) => {
        await tx.parkingOperator.delete({
          where: { id, lifecycleStatus: LifecycleStatus.TOMBSTONED },
        })
      })
      counts[outcome]++
    }
    return counts
  }

  private async purgeUsers(now: Date): Promise<PurgeCounts> {
    const counts: PurgeCounts = { purged: 0, blocked: 0 }
    const due = await this.prisma.user.findMany({
      where: { lifecycleStatus: LifecycleStatus.TOMBSTONED, purgeAfter: { lte: now } },
      select: { id: true, firebaseUid: true },
      orderBy: { purgeAfter: 'asc' },
      take: PURGE_BATCH_SIZE,
    })

    for (const row of due) {
      const unsettled = await this.prisma.booking.count({ where: this.unsettledWhere(row.id) })
      if (unsettled > 0) {
        counts.blocked++
        continue
      }
      // The uid is about to be nulled and is stored nowhere else; logging it is the ops
      // trail for cleaning up the remote identity, same as AccountDeletionService.
      if (row.firebaseUid) {
        this.logger.warn(
          `Purging user ${row.id}: Firebase identity ${row.firebaseUid} must be removed separately`,
        )
      }
      const outcome = await this.tryPurge('User', row.id, async (tx) => {
        const at = new Date()
        await tx.user.update({
          where: { id: row.id, lifecycleStatus: LifecycleStatus.TOMBSTONED },
          data: {
            email: tombstoneEmail(row.id),
            displayName: null,
            avatarUrl: null,
            passwordHash: null,
            firebaseUid: null,
            emailVerified: false,
            deletedAt: at,
            sessionsValidFrom: at,
            lifecycleStatus: LifecycleStatus.PURGED,
            lifecycleChangedAt: at,
            lifecycleReason: 'Retention purge: anonymised in place',
          },
        })
        await tx.vehicle.deleteMany({ where: { userId: row.id } })
        await tx.passwordResetToken.deleteMany({ where: { userId: row.id } })
      })
      counts[outcome]++
    }
    return counts
  }

  private due(
    delegate: {
      findMany(args: {
        where: { lifecycleStatus: LifecycleStatus; purgeAfter: { lte: Date } }
        select: { id: true }
        orderBy: { purgeAfter: 'asc' }
        take: number
      }): Promise<Array<{ id: string }>>
    },
    now: Date,
  ): Promise<Array<{ id: string }>> {
    return delegate.findMany({
      where: { lifecycleStatus: LifecycleStatus.TOMBSTONED, purgeAfter: { lte: now } },
      select: { id: true },
      orderBy: { purgeAfter: 'asc' },
      take: PURGE_BATCH_SIZE,
    })
  }

  /**
   * One row, one transaction, one audit entry. P2003 means a RESTRICT FK the pre-checks
   * did not cover still pins the row — blocked, not an error, retried next run. P2025
   * means another worker already removed or transitioned it — counted as purged since
   * the work is done. Anything else is logged and treated as blocked so a single broken
   * row can never wedge the sweep.
   */
  private async tryPurge(
    entityType: string,
    entityId: string,
    remove: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<'purged' | 'blocked'> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await remove(tx)
        await tx.auditLog.create({
          data: {
            actorId: null,
            actorRole: 'SYSTEM',
            action: `${entityType === 'User' ? 'user.purge_anonymised' : 'lifecycle.purged'}`,
            entityType,
            entityId,
          },
        })
      })
      return 'purged'
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === FK_RESTRICTED) return 'blocked'
        if (error.code === ROW_GONE) return 'purged'
      }
      this.logger.error(
        `Purge of ${entityType} ${entityId} failed; will retry next run`,
        error instanceof Error ? error.stack : String(error),
      )
      return 'blocked'
    }
  }

  // Mirrors AccountDeletionService.unsettledWhere: money mid-flight, a bay still being
  // held, or a car currently inside one. Anonymising the account under those would
  // strand a settlement nobody can complete.
  private unsettledWhere(userId: string): Prisma.BookingWhereInput {
    const now = new Date()
    return {
      userId,
      OR: [
        {
          status: { in: [BookingStatus.CONFIRMED, BookingStatus.CHECKED_IN] },
          endsAt: { gt: now },
        },
        { status: BookingStatus.PENDING_PAYMENT, expiresAt: { gt: now } },
        { status: BookingStatus.REFUND_PENDING },
      ],
    }
  }
}
