import { ForbiddenException, Injectable } from '@nestjs/common'
import { LifecycleStatus } from '@prisma/client'
import { hasPlatformPermission, type AuthUser, type PlatformPermission } from '@spark/types'
import { LifecycleActionBlockedError } from '../common/errors/domain.errors'
import { PrismaService } from '../prisma/prisma.service'
import type { ListTrashDto } from './dto/lifecycle-admin.dto'
import { LifecycleApprovalService } from './lifecycle-approval.service'
import { LifecycleImpactService } from './lifecycle-impact.service'
import { LifecyclePurgeService } from './lifecycle-purge.service'
import { LifecycleService, type LifecycleActor } from './lifecycle.service'
import {
  LIFECYCLE_RESOURCE_TYPES,
  RESOURCE_ENTITY_TYPE,
  type ApprovalList,
  type ApprovalView,
  type DestructiveAction,
  type ImpactReport,
  type LifecycleResourceType,
  type PurgeApprovalOutcome,
  type TrashItem,
  type TrashPage,
} from './lifecycle.types'

// "Trash" is everything that is administratively gone. ACTIVE rows belong to the ordinary
// resource endpoints, so they are only ever returned when explicitly asked for.
const NON_ACTIVE_STATUSES = [
  LifecycleStatus.ARCHIVED,
  LifecycleStatus.TOMBSTONED,
  LifecycleStatus.PURGED,
]

interface TrashRow {
  id: string
  name: string
  lifecycleStatus: LifecycleStatus
  lifecycleChangedAt: Date | null
  lifecycleChangedBy: string | null
  lifecycleReason: string | null
  purgeAfter: Date | null
}

/**
 * The platform-administration face of the lifecycle model. Every method re-checks the
 * permission its controller already gated on, per the both-layers rule, and every
 * destructive action runs the impact dry run first so the refusal a caller gets is the
 * same list the preview showed them.
 */
@Injectable()
export class LifecycleAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: LifecycleService,
    private readonly impact: LifecycleImpactService,
    private readonly approvals: LifecycleApprovalService,
    private readonly purge: LifecyclePurgeService,
  ) {}

  async listTrash(actor: AuthUser, query: ListTrashDto): Promise<TrashPage> {
    this.assertPermission(actor, 'platform:tenant.read', 'view the lifecycle trash')

    const statuses = query.status ? [query.status] : NON_ACTIVE_STATUSES
    const types = query.resourceType ? [query.resourceType] : [...LIFECYCLE_RESOURCE_TYPES]

    // Merge-then-slice across the requested types. Each type contributes at most
    // skip + take rows, which is the smallest prefix that can possibly hold the page once
    // the four streams are interleaved — cheap because skip is capped and take is <= 100.
    const window = query.skip + query.take
    const perType = await Promise.all(
      types.map(async (type) => ({
        type,
        rows: await this.trashRows(type, statuses, window),
        total: await this.trashCount(type, statuses),
      })),
    )

    const merged = perType
      .flatMap(({ type, rows }) => rows.map((row) => this.toTrashItem(type, row)))
      .sort(byChangedAtDesc)

    return {
      items: merged.slice(query.skip, query.skip + query.take),
      total: perType.reduce((sum, entry) => sum + entry.total, 0),
      skip: query.skip,
      take: query.take,
    }
  }

  // Async even where the body is a single delegation: a permission refusal must be a
  // rejected promise like every other failure, never a synchronous throw the caller's
  // .catch() would miss.
  async previewImpact(
    actor: AuthUser,
    resourceType: LifecycleResourceType,
    id: string,
    action: DestructiveAction,
  ): Promise<ImpactReport> {
    this.assertPermission(actor, 'platform:tenant.read', 'preview lifecycle impact')
    return this.impact.preview(resourceType, id, action)
  }

  async archive(
    actor: AuthUser,
    resourceType: LifecycleResourceType,
    id: string,
    reason: string,
  ): Promise<void> {
    this.assertPermission(actor, 'platform:tenant.write', 'archive resources')
    await this.assertUnblocked(resourceType, id, 'archive')

    const who = toLifecycleActor(actor)
    switch (resourceType) {
      case 'facility':
        return this.lifecycle.archiveFacility(who, id, reason)
      case 'tariff-plan':
        return this.lifecycle.archiveTariffPlan(who, id, reason)
      case 'operator':
        return this.lifecycle.archiveOperator(who, id, reason)
      case 'user':
        return this.lifecycle.archiveUser(who, id, reason)
    }
  }

  /**
   * Restore is deliberately NOT gated on the impact preview: it is the reversal, not a
   * destruction, and its own invariants live in LifecycleService — the operator facility
   * cap and the one-active-default-plan rule, both re-validated there and both surfaced
   * as LifecycleRestoreConflictError, which the filter maps to 409 with the conflicting
   * row named. Nothing here may swallow that into a 500.
   */
  async restore(
    actor: AuthUser,
    resourceType: LifecycleResourceType,
    id: string,
    reason?: string,
  ): Promise<void> {
    this.assertPermission(actor, 'platform:tenant.write', 'restore resources')

    const who = toLifecycleActor(actor)
    switch (resourceType) {
      case 'facility':
        return this.lifecycle.restoreFacility(who, id, reason)
      case 'tariff-plan':
        return this.lifecycle.restoreTariffPlan(who, id, reason)
      case 'operator':
        return this.lifecycle.restoreOperator(who, id, reason)
      case 'user':
        return this.lifecycle.restoreUser(who, id, reason)
    }
  }

  async tombstone(
    actor: AuthUser,
    resourceType: LifecycleResourceType,
    id: string,
    reason: string,
  ): Promise<void> {
    this.assertPermission(actor, 'platform:tenant.purge', 'tombstone resources')
    await this.assertUnblocked(resourceType, id, 'tombstone')

    const who = toLifecycleActor(actor)
    switch (resourceType) {
      case 'facility':
        return this.lifecycle.tombstoneFacility(who, id, reason)
      case 'tariff-plan':
        return this.lifecycle.tombstoneTariffPlan(who, id, reason)
      case 'operator':
        return this.lifecycle.tombstoneOperator(who, id, reason)
      case 'user':
        return this.lifecycle.tombstoneUser(who, id, reason)
    }
  }

  /**
   * Does NOT purge. It files a request for a second administrator to redeem — the blockers
   * are checked here so a request that could never succeed is never created, and again at
   * approval time because the state can change in between.
   */
  async requestPurge(
    actor: AuthUser,
    resourceType: LifecycleResourceType,
    id: string,
    reason: string,
  ): Promise<ApprovalView> {
    this.assertPermission(actor, 'platform:tenant.purge', 'purge resources')
    await this.assertUnblocked(resourceType, id, 'purge')
    return this.approvals.request(actor, resourceType, id, reason)
  }

  async listApprovals(actor: AuthUser): Promise<ApprovalList> {
    this.assertPermission(actor, 'platform:tenant.purge', 'view purge approvals')
    return this.approvals.list()
  }

  async approve(actor: AuthUser, approvalId: string): Promise<PurgeApprovalOutcome> {
    this.assertPermission(actor, 'platform:tenant.purge', 'approve a purge')

    const approval = await this.approvals.claim(actor, approvalId)
    const resourceType = approval.resourceType as LifecycleResourceType
    await this.assertUnblocked(resourceType, approval.resourceId, 'purge')

    await this.purge.purgeOne(toLifecycleActor(actor), resourceType, approval.resourceId, {
      reason: approval.reason,
      approvalId: approval.id,
      requestedBy: approval.requestedBy,
    })

    return {
      approval: {
        id: approval.id,
        action: approval.action,
        resourceType: approval.resourceType,
        resourceId: approval.resourceId,
        reason: approval.reason,
        requestedBy: approval.requestedBy,
        requestedByRole: approval.requestedByRole,
        status: approval.status,
        expiresAt: approval.expiresAt.toISOString(),
        decidedBy: approval.decidedBy,
        decidedAt: approval.decidedAt?.toISOString() ?? null,
        decisionReason: approval.decisionReason,
        createdAt: approval.createdAt.toISOString(),
      },
      purged: true,
    }
  }

  async reject(actor: AuthUser, approvalId: string, reason: string): Promise<ApprovalView> {
    this.assertPermission(actor, 'platform:tenant.purge', 'reject a purge')
    return this.approvals.reject(actor, approvalId, reason)
  }

  private async assertUnblocked(
    resourceType: LifecycleResourceType,
    id: string,
    action: DestructiveAction,
  ): Promise<void> {
    const report = await this.impact.preview(resourceType, id, action)
    if (report.blockers.length > 0) {
      throw new LifecycleActionBlockedError(
        action,
        RESOURCE_ENTITY_TYPE[resourceType],
        id,
        report.blockers,
      )
    }
  }

  private assertPermission(actor: AuthUser, permission: PlatformPermission, action: string): void {
    // Controller already gates on the same permission; re-check in the service layer per
    // the both-layers authorization rule.
    if (!hasPlatformPermission(actor.role, permission)) {
      throw new ForbiddenException(`Only platform admins may ${action}`)
    }
  }

  // Every read here names lifecycleStatus explicitly, which is the extension's documented
  // opt-out (anyLifecycleStatus): an admin trash view that could not see non-ACTIVE rows
  // would be empty by construction.
  private trashRows(
    resourceType: LifecycleResourceType,
    statuses: LifecycleStatus[],
    take: number,
  ): Promise<TrashRow[]> {
    const orderBy = [
      { lifecycleChangedAt: { sort: 'desc', nulls: 'last' } as const },
      { id: 'asc' as const },
    ]
    const select = {
      id: true,
      lifecycleStatus: true,
      lifecycleChangedAt: true,
      lifecycleChangedBy: true,
      lifecycleReason: true,
      purgeAfter: true,
    }

    switch (resourceType) {
      case 'facility':
        return this.prisma.facility.findMany({
          where: { lifecycleStatus: { in: statuses } },
          select: { ...select, name: true },
          orderBy,
          take,
        })
      case 'tariff-plan':
        return this.prisma.tariffPlan.findMany({
          where: { lifecycleStatus: { in: statuses } },
          select: { ...select, name: true },
          orderBy,
          take,
        })
      case 'operator':
        return this.prisma.parkingOperator.findMany({
          where: { lifecycleStatus: { in: statuses } },
          select: { ...select, name: true },
          orderBy,
          take,
        })
      case 'user':
        return this.prisma.user
          .findMany({
            where: { lifecycleStatus: { in: statuses } },
            select: { ...select, displayName: true, email: true },
            orderBy,
            take,
          })
          .then((rows) =>
            rows.map(({ displayName, email, ...rest }) => ({
              ...rest,
              name: displayName ?? email,
            })),
          )
    }
  }

  private trashCount(
    resourceType: LifecycleResourceType,
    statuses: LifecycleStatus[],
  ): Promise<number> {
    const where = { lifecycleStatus: { in: statuses } }
    switch (resourceType) {
      case 'facility':
        return this.prisma.facility.count({ where })
      case 'tariff-plan':
        return this.prisma.tariffPlan.count({ where })
      case 'operator':
        return this.prisma.parkingOperator.count({ where })
      case 'user':
        return this.prisma.user.count({ where })
    }
  }

  private toTrashItem(resourceType: LifecycleResourceType, row: TrashRow): TrashItem {
    return {
      resourceType,
      id: row.id,
      name: row.name,
      status: row.lifecycleStatus,
      changedAt: row.lifecycleChangedAt?.toISOString() ?? null,
      changedBy: row.lifecycleChangedBy,
      reason: row.lifecycleReason,
      purgeAfter: row.purgeAfter?.toISOString() ?? null,
    }
  }
}

function byChangedAtDesc(a: TrashItem, b: TrashItem): number {
  if (a.changedAt === b.changedAt) return a.id < b.id ? -1 : 1
  if (!a.changedAt) return 1
  if (!b.changedAt) return -1
  return a.changedAt < b.changedAt ? 1 : -1
}

function toLifecycleActor(actor: AuthUser): LifecycleActor {
  return { id: actor.id, role: actor.role }
}
