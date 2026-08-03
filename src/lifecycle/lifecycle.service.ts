import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { LifecycleStatus, Prisma } from '@prisma/client'
import { RequestContext } from '../common/context/request-context'
import {
  FacilityHasActiveBookingsError,
  LifecycleResourceNotFoundError,
  LifecycleRestoreConflictError,
  LifecycleTransitionError,
  OperatorHasActiveFacilitiesError,
} from '../common/errors/domain.errors'
import { unhonouredBookingsWhere } from '../booking/booking.predicates'
import { anyLifecycleStatus } from '../prisma/lifecycle.extension'
import { PrismaService } from '../prisma/prisma.service'
import { EntitlementService } from '../subscriptions/entitlement.service'

export interface LifecycleActor {
  id: string
  role: string
}

const DAY_MS = 86_400_000

interface LifecycleWrite {
  lifecycleStatus: LifecycleStatus
  lifecycleChangedAt: Date
  lifecycleChangedBy: string
  lifecycleReason: string | null
  purgeAfter: Date | null
}

/**
 * Archive, restore and tombstone for the four lifecycle resources. This is the service
 * API the platform-administration endpoints will call; purge is LifecyclePurgeService's
 * job. Every write goes through an explicit `lifecycleStatus` in its `where`, which both
 * opts out of the default-ACTIVE filter and makes each transition an optimistic
 * state-guarded update.
 */
@Injectable()
export class LifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly entitlements: EntitlementService,
  ) {}

  async archiveFacility(actor: LifecycleActor, id: string, reason?: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const row = await this.loadFacility(tx, id, [LifecycleStatus.ACTIVE], 'archived')
      await this.assertNoUnhonouredBookings(tx, id)
      // Forced unpublish: the public search predicate lives in raw SQL the default
      // filter cannot reach, so isActive=false is what keeps even those paths safe.
      await tx.facility.update({
        where: { id, lifecycleStatus: row.lifecycleStatus },
        data: { ...this.write(actor, LifecycleStatus.ARCHIVED, reason), isActive: false },
      })
      await this.audit(tx, actor, 'facility.archived', 'Facility', id, { reason: reason ?? null })
    })
  }

  async tombstoneFacility(actor: LifecycleActor, id: string, reason?: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const row = await this.loadFacility(
        tx,
        id,
        [LifecycleStatus.ACTIVE, LifecycleStatus.ARCHIVED],
        'tombstoned',
      )
      await this.assertNoUnhonouredBookings(tx, id)
      const purgeAfter = this.purgeAfterInstant()
      await tx.facility.update({
        where: { id, lifecycleStatus: row.lifecycleStatus },
        data: {
          ...this.write(actor, LifecycleStatus.TOMBSTONED, reason, purgeAfter),
          isActive: false,
        },
      })
      await this.audit(tx, actor, 'facility.tombstoned', 'Facility', id, {
        reason: reason ?? null,
        purgeAfter: purgeAfter.toISOString(),
      })
    })
  }

  /**
   * Restore re-validates the operator's facility entitlement rather than just clearing the
   * flag: archiving freed a quota slot, the operator may have filled it meanwhile, and
   * restoring consumes one again. isActive is NOT touched — archiving unpublished the
   * facility and restore never republishes.
   *
   * `reason` lands in the audit row only, never in lifecycleReason: that column describes
   * why the row is in its CURRENT state, and every restore clears it. Writing a restore
   * motive there would leave an ACTIVE row explaining why it was archived.
   */
  async restoreFacility(actor: LifecycleActor, id: string, reason?: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const row = await this.loadFacility(
        tx,
        id,
        [LifecycleStatus.ARCHIVED, LifecycleStatus.TOMBSTONED],
        'restored',
      )

      // Restoring returns a facility to the ACTIVE set, so it consumes quota exactly like
      // a create and must clear the same entitlement check — the operator may now be on a
      // multi-facility plan. Lock the operator row first: the partial unique index that
      // used to backstop this was dropped with the one-facility cap, so this lock is the
      // only thing serialising a restore against a concurrent create. An operator-less
      // facility has no operator row to lock and no quota to check.
      if (row.operatorId !== null) {
        await tx.$executeRaw`SELECT id FROM "ParkingOperator" WHERE id = ${row.operatorId} FOR UPDATE`
        await this.entitlements.assertCanCreateFacility(row.operatorId, tx)
      }

      await tx.facility.update({
        where: { id, lifecycleStatus: row.lifecycleStatus },
        data: this.write(actor, LifecycleStatus.ACTIVE, undefined),
      })
      await this.audit(tx, actor, 'facility.restored', 'Facility', id, { reason: reason ?? null })
    })
  }

  /**
   * Unlike Facility, archiving a plan PRESERVES isActive and isDefault: applicability is
   * enforced in memory (isPlanApplicable checks lifecycle) and the operator-default
   * partial unique index counts only lifecycle-ACTIVE rows — so archiving a default
   * frees the slot while keeping the exact state whose conflicts restore re-validates.
   *
   * `tx` folds the archive into a caller's own transaction. TariffService.deletePlan
   * needs it: unassigning every facility and archiving the plan are one delete, and
   * committing the first without the second silently reprices those facilities onto the
   * operator default while the plan they pointed at is still listed.
   */
  async archiveTariffPlan(
    actor: LifecycleActor,
    id: string,
    reason?: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const run = async (client: Prisma.TransactionClient): Promise<void> => {
      const row = await this.loadTariffPlan(client, id, [LifecycleStatus.ACTIVE], 'archived')
      await client.tariffPlan.update({
        where: { id, lifecycleStatus: row.lifecycleStatus },
        data: this.write(actor, LifecycleStatus.ARCHIVED, reason),
      })
      await this.audit(client, actor, 'tariff_plan.archived', 'TariffPlan', id, {
        reason: reason ?? null,
      })
    }

    return tx ? run(tx) : this.prisma.$transaction(run)
  }

  async tombstoneTariffPlan(actor: LifecycleActor, id: string, reason?: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const row = await this.loadTariffPlan(
        tx,
        id,
        [LifecycleStatus.ACTIVE, LifecycleStatus.ARCHIVED],
        'tombstoned',
      )
      const purgeAfter = this.purgeAfterInstant()
      await tx.tariffPlan.update({
        where: { id, lifecycleStatus: row.lifecycleStatus },
        data: this.write(actor, LifecycleStatus.TOMBSTONED, reason, purgeAfter),
      })
      await this.audit(tx, actor, 'tariff_plan.tombstoned', 'TariffPlan', id, {
        reason: reason ?? null,
        purgeAfter: purgeAfter.toISOString(),
      })
    })
  }

  async restoreTariffPlan(actor: LifecycleActor, id: string, reason?: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const row = await this.loadTariffPlan(
        tx,
        id,
        [LifecycleStatus.ARCHIVED, LifecycleStatus.TOMBSTONED],
        'restored',
      )

      if (row.isDefault && row.isActive) {
        const conflict = await tx.tariffPlan.findFirst({
          where: {
            operatorId: row.operatorId,
            isDefault: true,
            isActive: true,
            id: { not: id },
            lifecycleStatus: LifecycleStatus.ACTIVE,
          },
          select: { id: true, name: true },
        })
        if (conflict) {
          throw new LifecycleRestoreConflictError(
            'tariff plan',
            id,
            `plan ${conflict.id} "${conflict.name}" is now the operator's active default. Demote it first, or restore this plan after unsetting its default flag.`,
          )
        }
      }

      try {
        await tx.tariffPlan.update({
          where: { id, lifecycleStatus: row.lifecycleStatus },
          data: this.write(actor, LifecycleStatus.ACTIVE, undefined),
        })
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new LifecycleRestoreConflictError(
            'tariff plan',
            id,
            'a concurrent change claimed the operator default slot this restore needs. Re-check and retry.',
          )
        }
        throw error
      }
      await this.audit(tx, actor, 'tariff_plan.restored', 'TariffPlan', id, {
        reason: reason ?? null,
      })
    })
  }

  async archiveOperator(actor: LifecycleActor, id: string, reason?: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const row = await this.loadOperator(tx, id, [LifecycleStatus.ACTIVE], 'archived')
      await this.assertNoActiveFacilities(tx, id)
      await tx.parkingOperator.update({
        where: { id, lifecycleStatus: row.lifecycleStatus },
        data: this.write(actor, LifecycleStatus.ARCHIVED, reason),
      })
      await this.audit(tx, actor, 'operator.archived', 'ParkingOperator', id, {
        reason: reason ?? null,
      })
    })
  }

  async tombstoneOperator(actor: LifecycleActor, id: string, reason?: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const row = await this.loadOperator(
        tx,
        id,
        [LifecycleStatus.ACTIVE, LifecycleStatus.ARCHIVED],
        'tombstoned',
      )
      await this.assertNoActiveFacilities(tx, id)
      const purgeAfter = this.purgeAfterInstant()
      await tx.parkingOperator.update({
        where: { id, lifecycleStatus: row.lifecycleStatus },
        data: this.write(actor, LifecycleStatus.TOMBSTONED, reason, purgeAfter),
      })
      await this.audit(tx, actor, 'operator.tombstoned', 'ParkingOperator', id, {
        reason: reason ?? null,
        purgeAfter: purgeAfter.toISOString(),
      })
    })
  }

  async restoreOperator(actor: LifecycleActor, id: string, reason?: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const row = await this.loadOperator(
        tx,
        id,
        [LifecycleStatus.ARCHIVED, LifecycleStatus.TOMBSTONED],
        'restored',
      )
      await tx.parkingOperator.update({
        where: { id, lifecycleStatus: row.lifecycleStatus },
        data: this.write(actor, LifecycleStatus.ACTIVE, undefined),
      })
      await this.audit(tx, actor, 'operator.restored', 'ParkingOperator', id, {
        reason: reason ?? null,
      })
    })
  }

  async archiveUser(actor: LifecycleActor, id: string, reason?: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const row = await this.loadUser(tx, id, [LifecycleStatus.ACTIVE], 'archived')
      // The default filter already makes every user lookup fail for this row, but tokens
      // issued before the archive must die too — the watermark is the check that does
      // not depend on any particular lookup path.
      await tx.user.update({
        where: { id, lifecycleStatus: row.lifecycleStatus },
        data: {
          ...this.write(actor, LifecycleStatus.ARCHIVED, reason),
          sessionsValidFrom: new Date(),
        },
      })
      await this.audit(tx, actor, 'user.archived', 'User', id, { reason: reason ?? null })
    })
  }

  async tombstoneUser(actor: LifecycleActor, id: string, reason?: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const row = await this.loadUser(
        tx,
        id,
        [LifecycleStatus.ACTIVE, LifecycleStatus.ARCHIVED],
        'tombstoned',
      )
      const purgeAfter = this.purgeAfterInstant()
      await tx.user.update({
        where: { id, lifecycleStatus: row.lifecycleStatus },
        data: {
          ...this.write(actor, LifecycleStatus.TOMBSTONED, reason, purgeAfter),
          sessionsValidFrom: new Date(),
        },
      })
      await this.audit(tx, actor, 'user.tombstoned', 'User', id, {
        reason: reason ?? null,
        purgeAfter: purgeAfter.toISOString(),
      })
    })
  }

  async restoreUser(actor: LifecycleActor, id: string, reason?: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const row = await this.loadUser(
        tx,
        id,
        [LifecycleStatus.ARCHIVED, LifecycleStatus.TOMBSTONED],
        'restored',
      )
      if (row.deletedAt) {
        throw new LifecycleRestoreConflictError(
          'user',
          id,
          'the account was anonymised by account deletion and has no identity left to restore.',
        )
      }
      await tx.user.update({
        where: { id, lifecycleStatus: row.lifecycleStatus },
        data: this.write(actor, LifecycleStatus.ACTIVE, undefined),
      })
      await this.audit(tx, actor, 'user.restored', 'User', id, { reason: reason ?? null })
    })
  }

  private write(
    actor: LifecycleActor,
    status: LifecycleStatus,
    reason: string | undefined,
    purgeAfter: Date | null = null,
  ): LifecycleWrite {
    return {
      lifecycleStatus: status,
      lifecycleChangedAt: new Date(),
      lifecycleChangedBy: actor.id,
      lifecycleReason: reason ?? null,
      purgeAfter,
    }
  }

  private purgeAfterInstant(): Date {
    const days = this.config.get<number>('LIFECYCLE_PURGE_RETENTION_DAYS') ?? 30
    return new Date(Date.now() + days * DAY_MS)
  }

  private async assertNoUnhonouredBookings(
    tx: Prisma.TransactionClient,
    facilityId: string,
  ): Promise<void> {
    const unhonoured = await tx.booking.count({ where: unhonouredBookingsWhere(facilityId) })
    if (unhonoured > 0) throw new FacilityHasActiveBookingsError(facilityId, unhonoured)
  }

  private async assertNoActiveFacilities(
    tx: Prisma.TransactionClient,
    operatorId: string,
  ): Promise<void> {
    const active = await tx.facility.count({
      where: { operatorId, lifecycleStatus: LifecycleStatus.ACTIVE },
    })
    if (active > 0) throw new OperatorHasActiveFacilitiesError(operatorId, active)
  }

  private async loadFacility(
    tx: Prisma.TransactionClient,
    id: string,
    from: LifecycleStatus[],
    verb: string,
  ) {
    const row = await tx.facility.findFirst({
      where: { id, lifecycleStatus: anyLifecycleStatus() },
      select: { id: true, operatorId: true, lifecycleStatus: true },
    })
    if (!row) throw new LifecycleResourceNotFoundError('Facility', id)
    if (!from.includes(row.lifecycleStatus)) {
      throw new LifecycleTransitionError('Facility', id, row.lifecycleStatus, verb)
    }
    return row
  }

  private async loadTariffPlan(
    tx: Prisma.TransactionClient,
    id: string,
    from: LifecycleStatus[],
    verb: string,
  ) {
    const row = await tx.tariffPlan.findFirst({
      where: { id, lifecycleStatus: anyLifecycleStatus() },
      select: {
        id: true,
        operatorId: true,
        lifecycleStatus: true,
        isActive: true,
        isDefault: true,
      },
    })
    if (!row) throw new LifecycleResourceNotFoundError('Tariff plan', id)
    if (!from.includes(row.lifecycleStatus)) {
      throw new LifecycleTransitionError('Tariff plan', id, row.lifecycleStatus, verb)
    }
    return row
  }

  private async loadOperator(
    tx: Prisma.TransactionClient,
    id: string,
    from: LifecycleStatus[],
    verb: string,
  ) {
    const row = await tx.parkingOperator.findFirst({
      where: { id, lifecycleStatus: anyLifecycleStatus() },
      select: { id: true, lifecycleStatus: true },
    })
    if (!row) throw new LifecycleResourceNotFoundError('Operator', id)
    if (!from.includes(row.lifecycleStatus)) {
      throw new LifecycleTransitionError('Operator', id, row.lifecycleStatus, verb)
    }
    return row
  }

  private async loadUser(
    tx: Prisma.TransactionClient,
    id: string,
    from: LifecycleStatus[],
    verb: string,
  ) {
    const row = await tx.user.findFirst({
      where: { id, lifecycleStatus: anyLifecycleStatus() },
      select: { id: true, lifecycleStatus: true, deletedAt: true },
    })
    if (!row) throw new LifecycleResourceNotFoundError('User', id)
    if (!from.includes(row.lifecycleStatus)) {
      throw new LifecycleTransitionError('User', id, row.lifecycleStatus, verb)
    }
    return row
  }

  private async audit(
    tx: Prisma.TransactionClient,
    actor: LifecycleActor,
    action: string,
    entityType: string,
    entityId: string,
    payload?: Record<string, string | null>,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        actorId: actor.id,
        actorRole: actor.role,
        action,
        entityType,
        entityId,
        ipAddress: RequestContext.getIp(),
        ...(payload ? { payload } : {}),
      },
    })
  }
}
