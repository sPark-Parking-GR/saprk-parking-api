import { Injectable, Logger } from '@nestjs/common'
import { BookingStatus, LifecycleStatus, Prisma } from '@prisma/client'
import { RequestContext } from '../common/context/request-context'
import {
  LifecycleResourceNotFoundError,
  LifecycleTransitionError,
} from '../common/errors/domain.errors'
import { anyLifecycleStatus } from '../prisma/lifecycle.extension'
import { PrismaService } from '../prisma/prisma.service'
import type { LifecycleActor } from './lifecycle.service'
import {
  RESOURCE_AUDIT_PREFIX,
  RESOURCE_ENTITY_TYPE,
  type LifecycleResourceType,
} from './lifecycle.types'

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

/**
 * Everything that physically pins a row against deletion, counted per resource. The batch
 * sweep, the on-demand purge and the impact dry run all read these same numbers, so what
 * an administrator is shown before approving is what actually decides the outcome.
 */
export interface PurgeRefs {
  /** Non-zero means the purge cannot proceed at all. */
  blocking: number
  counts: Record<string, number>
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
      const refs = await this.facilityRefs(id)
      if (refs.blocking > 0) {
        counts.blocked++
        continue
      }
      const outcome = await this.tryPurge('Facility', id, (tx) => this.removeFacility(tx, id))
      counts[outcome]++
    }
    return counts
  }

  private async purgeTariffPlans(now: Date): Promise<PurgeCounts> {
    const counts: PurgeCounts = { purged: 0, blocked: 0 }
    const due = await this.due(this.prisma.tariffPlan, now)

    for (const { id } of due) {
      const outcome = await this.tryPurge('TariffPlan', id, (tx) => this.removeTariffPlan(tx, id))
      counts[outcome]++
    }
    return counts
  }

  private async purgeOperators(now: Date): Promise<PurgeCounts> {
    const counts: PurgeCounts = { purged: 0, blocked: 0 }
    const due = await this.due(this.prisma.parkingOperator, now)

    for (const { id } of due) {
      const refs = await this.operatorRefs(id)
      if (refs.blocking > 0) {
        counts.blocked++
        continue
      }
      const outcome = await this.tryPurge('ParkingOperator', id, (tx) =>
        this.removeOperator(tx, id),
      )
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
      const refs = await this.userRefs(row.id)
      if (refs.blocking > 0) {
        counts.blocked++
        continue
      }
      this.warnAboutRemoteIdentity(row.id, row.firebaseUid)
      const outcome = await this.tryPurge('User', row.id, (tx) => this.anonymiseUser(tx, row.id))
      counts[outcome]++
    }
    return counts
  }

  /**
   * A purge an administrator asked for and a second one approved, applied now rather than
   * when the retention window lapses. It runs the same reference checks and the same
   * removal recipes as the sweep — the only differences are that it names one row, that a
   * blocked row is an error the caller must see instead of a counter, and that the audit
   * entry carries the human who approved it and their stated reason.
   */
  async purgeOne(
    actor: LifecycleActor,
    resourceType: LifecycleResourceType,
    id: string,
    audit: { reason: string; approvalId: string; requestedBy: string },
  ): Promise<void> {
    const entityType = RESOURCE_ENTITY_TYPE[resourceType]
    await this.assertTombstoned(resourceType, id, entityType)

    if (resourceType === 'user') {
      const row = await this.prisma.user.findFirst({
        where: { id, lifecycleStatus: anyLifecycleStatus() },
        select: { firebaseUid: true },
      })
      this.warnAboutRemoteIdentity(id, row?.firebaseUid ?? null)
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        await this.remove(tx, resourceType, id)
        await tx.auditLog.create({
          data: {
            actorId: actor.id,
            actorRole: actor.role,
            action: `${RESOURCE_AUDIT_PREFIX[resourceType]}.purged`,
            entityType,
            entityId: id,
            payload: {
              reason: audit.reason,
              approvalId: audit.approvalId,
              requestedBy: audit.requestedBy,
            },
            ipAddress: RequestContext.getIp(),
          },
        })
      })
    } catch (error) {
      // A RESTRICT FK the pre-checks did not cover. The sweep counts this as blocked and
      // retries; an on-demand purge has a caller waiting, so it is told instead.
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === FK_RESTRICTED) {
          throw new LifecycleTransitionError(
            entityType,
            id,
            'referenced by other records',
            'purged',
          )
        }
        if (error.code === ROW_GONE) throw new LifecycleResourceNotFoundError(entityType, id)
      }
      throw error
    }
  }

  /** Bookings are ON DELETE RESTRICT, so any one of them pins the facility forever. */
  async facilityRefs(id: string): Promise<PurgeRefs> {
    const bookings = await this.prisma.booking.count({ where: { facilityId: id } })
    return { blocking: bookings, counts: { bookings } }
  }

  /**
   * Nothing pins a plan: its schedule cascades and bookings pin plans by (id, version)
   * value rather than by FK. Kept as a method so every resource is asked the same question.
   */
  tariffPlanRefs(): Promise<PurgeRefs> {
    return Promise.resolve({ blocking: 0, counts: {} })
  }

  async operatorRefs(id: string): Promise<PurgeRefs> {
    // The facility count must see EVERY lifecycle state: a tombstoned facility still
    // physically references its operator, and the default filter would hide it.
    const [facilities, ownershipPeriods, promotionPlans] = await Promise.all([
      this.prisma.facility.count({
        where: { operatorId: id, lifecycleStatus: anyLifecycleStatus() },
      }),
      this.prisma.facilityOwnershipPeriod.count({ where: { operatorId: id } }),
      this.prisma.promotionPlan.count({ where: { operatorId: id } }),
    ])
    return {
      blocking: facilities + ownershipPeriods + promotionPlans,
      counts: { facilities, ownershipPeriods, promotionPlans },
    }
  }

  async userRefs(id: string): Promise<PurgeRefs> {
    const unsettledBookings = await this.prisma.booking.count({ where: unsettledWhere(id) })
    return { blocking: unsettledBookings, counts: { unsettledBookings } }
  }

  refs(resourceType: LifecycleResourceType, id: string): Promise<PurgeRefs> {
    switch (resourceType) {
      case 'facility':
        return this.facilityRefs(id)
      case 'tariff-plan':
        return this.tariffPlanRefs()
      case 'operator':
        return this.operatorRefs(id)
      case 'user':
        return this.userRefs(id)
    }
  }

  private async assertTombstoned(
    resourceType: LifecycleResourceType,
    id: string,
    entityType: string,
  ): Promise<void> {
    const where = { id, lifecycleStatus: anyLifecycleStatus() }
    const select = { lifecycleStatus: true } as const
    const row =
      resourceType === 'facility'
        ? await this.prisma.facility.findFirst({ where, select })
        : resourceType === 'tariff-plan'
          ? await this.prisma.tariffPlan.findFirst({ where, select })
          : resourceType === 'operator'
            ? await this.prisma.parkingOperator.findFirst({ where, select })
            : await this.prisma.user.findFirst({ where, select })

    if (!row) throw new LifecycleResourceNotFoundError(entityType, id)
    if (row.lifecycleStatus !== LifecycleStatus.TOMBSTONED) {
      throw new LifecycleTransitionError(entityType, id, row.lifecycleStatus, 'purged')
    }
  }

  private remove(
    tx: Prisma.TransactionClient,
    resourceType: LifecycleResourceType,
    id: string,
  ): Promise<void> {
    switch (resourceType) {
      case 'facility':
        return this.removeFacility(tx, id)
      case 'tariff-plan':
        return this.removeTariffPlan(tx, id)
      case 'operator':
        return this.removeOperator(tx, id)
      case 'user':
        return this.anonymiseUser(tx, id)
    }
  }

  private async removeFacility(tx: Prisma.TransactionClient, id: string): Promise<void> {
    await tx.facility.delete({ where: { id, lifecycleStatus: LifecycleStatus.TOMBSTONED } })
  }

  private async removeTariffPlan(tx: Prisma.TransactionClient, id: string): Promise<void> {
    await tx.tariffPlan.delete({ where: { id, lifecycleStatus: LifecycleStatus.TOMBSTONED } })
  }

  private async removeOperator(tx: Prisma.TransactionClient, id: string): Promise<void> {
    await tx.parkingOperator.delete({ where: { id, lifecycleStatus: LifecycleStatus.TOMBSTONED } })
  }

  private async anonymiseUser(tx: Prisma.TransactionClient, id: string): Promise<void> {
    const at = new Date()
    await tx.user.update({
      where: { id, lifecycleStatus: LifecycleStatus.TOMBSTONED },
      data: {
        email: tombstoneEmail(id),
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
    await tx.vehicle.deleteMany({ where: { userId: id } })
    await tx.passwordResetToken.deleteMany({ where: { userId: id } })
    // The User row SURVIVES this path, so the ON DELETE CASCADE on these two never fires.
    // Left behind, a purged account's management assignments stay live grants on real
    // facilities and plans. Only removed at PURGE: an ARCHIVED user is coming back, and a
    // restore that returned them to an empty dashboard would be a silent demotion.
    await tx.facilityManager.deleteMany({ where: { userId: id } })
    await tx.tariffPlanManager.deleteMany({ where: { userId: id } })
  }

  // The uid is about to be nulled and is stored nowhere else; logging it is the ops
  // trail for cleaning up the remote identity, same as AccountDeletionService.
  private warnAboutRemoteIdentity(userId: string, firebaseUid: string | null): void {
    if (!firebaseUid) return
    this.logger.warn(
      `Purging user ${userId}: Firebase identity ${firebaseUid} must be removed separately`,
    )
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
}

// Mirrors AccountDeletionService.unsettledWhere: money mid-flight, a bay still being
// held, or a car currently inside one. Anonymising the account under those would
// strand a settlement nobody can complete. Exported so the impact dry run counts exactly
// the rows the purge will refuse over, following the unhonouredBookingsWhere convention.
export function unsettledWhere(userId: string): Prisma.BookingWhereInput {
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
