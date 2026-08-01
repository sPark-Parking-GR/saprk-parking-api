import { Injectable } from '@nestjs/common'
import { ApprovalStatus, LifecycleStatus, UserRole as PrismaUserRole } from '@prisma/client'
import type { PendingApproval, Prisma } from '@prisma/client'
import {
  hasPlatformPermission,
  USER_ROLES,
  type AuthUser,
  type UserRole as ContractRole,
} from '@spark/types'
import { RequestContext } from '../common/context/request-context'
import {
  ApprovalAlreadyPendingError,
  ApprovalExpiredError,
  ApprovalNotFoundError,
  ApprovalNotPendingError,
  PurgeApproverUnavailableError,
  SelfApprovalError,
} from '../common/errors/domain.errors'
import { PrismaService } from '../prisma/prisma.service'
import {
  RESOURCE_ENTITY_TYPE,
  type ApprovalList,
  type ApprovalView,
  type LifecycleResourceType,
} from './lifecycle.types'

export const PURGE_ACTION = 'purge'

/**
 * How long a request stays redeemable. Long enough that a second administrator in another
 * timezone can look at it, short enough that an approval cannot sit around as a latent
 * capability. Checked at redemption rather than swept by a job, so a stopped worker can
 * never widen the window.
 */
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000

const TO_PRISMA_ROLE: Record<ContractRole, PrismaUserRole> = {
  guest: PrismaUserRole.USER,
  user: PrismaUserRole.USER,
  operator_staff: PrismaUserRole.OPERATOR_STAFF,
  operator_admin: PrismaUserRole.OPERATOR_ADMIN,
  platform_admin: PrismaUserRole.PLATFORM_ADMIN,
}

// Derived from the permission map rather than hardcoded to PLATFORM_ADMIN, so introducing
// a second purge-capable role automatically counts towards the two-person rule.
const PURGE_CAPABLE_PRISMA_ROLES = [
  ...new Set(
    USER_ROLES.filter((role) => hasPlatformPermission(role, 'platform:tenant.purge')).map(
      (role) => TO_PRISMA_ROLE[role],
    ),
  ),
]

/**
 * The two-person rule. A purge is requested by one platform administrator and carried out
 * only when a DIFFERENT one redeems the request, within 24 hours.
 *
 * FAIL CLOSED ON A FRESH INSTALL. `bootstrap:admin` creates exactly one platform owner, so
 * a brand-new deployment has nobody to ask, and requestPurge refuses until a second holder
 * of platform:tenant.purge exists. The tempting alternative — waive the rule while only one
 * holder exists — disables the control in precisely the situation it defends against: a
 * single compromised or coerced administrator on an install that has not yet grown a second
 * pair of eyes. The remedy is one role grant, it is discoverable from the error message,
 * and nothing else in the product is blocked meanwhile: archive and tombstone still work,
 * and tombstoned rows are purged by the retention worker on their own schedule.
 */
@Injectable()
export class LifecycleApprovalService {
  constructor(private readonly prisma: PrismaService) {}

  async request(
    actor: AuthUser,
    resourceType: LifecycleResourceType,
    resourceId: string,
    reason: string,
  ): Promise<ApprovalView> {
    await this.assertSecondApproverExists(actor)

    const now = new Date()
    const approval = await this.prisma.$transaction(async (tx) => {
      await this.lapseExpired(tx, resourceType, resourceId, now)

      const live = await tx.pendingApproval.findFirst({
        where: {
          action: PURGE_ACTION,
          resourceType,
          resourceId,
          status: ApprovalStatus.PENDING,
        },
        select: { id: true },
      })
      if (live) throw new ApprovalAlreadyPendingError(live.id)

      const created = await tx.pendingApproval.create({
        data: {
          action: PURGE_ACTION,
          resourceType,
          resourceId,
          reason,
          requestedBy: actor.id,
          requestedByRole: actor.role,
          expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS),
        },
      })

      await this.audit(tx, actor, 'lifecycle.purge_requested', resourceType, resourceId, {
        approvalId: created.id,
        reason,
        expiresAt: created.expiresAt.toISOString(),
      })

      return created
    })

    return toView(approval)
  }

  async list(): Promise<ApprovalList> {
    const now = new Date()
    const items = await this.prisma.pendingApproval.findMany({
      where: { status: ApprovalStatus.PENDING, expiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
    })
    return { items: items.map(toView), total: items.length }
  }

  /**
   * Claims the approval and hands the caller the resource to destroy. The claim and the
   * purge are separate transactions on purpose: the purge may touch many rows and must not
   * hold the approval row's lock while it does. The state-guarded updateMany is what makes
   * that safe — exactly one concurrent approver can move PENDING to APPROVED, so a
   * double-click or two administrators racing produce one purge, not two.
   */
  async claim(actor: AuthUser, approvalId: string): Promise<PendingApproval> {
    const now = new Date()
    await this.burnIfExpired(approvalId, now)

    return this.prisma.$transaction(async (tx) => {
      const approval = await tx.pendingApproval.findUnique({ where: { id: approvalId } })
      if (!approval) throw new ApprovalNotFoundError(approvalId)
      if (approval.status === ApprovalStatus.EXPIRED) throw new ApprovalExpiredError(approvalId)
      if (approval.status !== ApprovalStatus.PENDING) {
        throw new ApprovalNotPendingError(approvalId, approval.status)
      }
      if (approval.requestedBy === actor.id) throw new SelfApprovalError()

      const { count } = await tx.pendingApproval.updateMany({
        where: { id: approvalId, status: ApprovalStatus.PENDING, expiresAt: { gt: now } },
        data: {
          status: ApprovalStatus.APPROVED,
          decidedBy: actor.id,
          decidedByRole: actor.role,
          decidedAt: now,
        },
      })
      // A competing approver committed between the read above and this guarded write.
      if (count === 0) throw new ApprovalNotPendingError(approvalId, 'decided')

      await this.audit(
        tx,
        actor,
        'lifecycle.purge_approved',
        approval.resourceType,
        approval.resourceId,
        {
          approvalId,
          reason: approval.reason,
          requestedBy: approval.requestedBy,
        },
      )

      return {
        ...approval,
        status: ApprovalStatus.APPROVED,
        decidedBy: actor.id,
        decidedByRole: actor.role,
        decidedAt: now,
      }
    })
  }

  /**
   * Rejecting is open to the requester too: refusing your own request is withdrawing it,
   * which removes a capability rather than granting one. Only APPROVING is restricted.
   */
  async reject(actor: AuthUser, approvalId: string, reason: string): Promise<ApprovalView> {
    const now = new Date()
    await this.burnIfExpired(approvalId, now)

    const approval = await this.prisma.$transaction(async (tx) => {
      const row = await tx.pendingApproval.findUnique({ where: { id: approvalId } })
      if (!row) throw new ApprovalNotFoundError(approvalId)
      if (row.status === ApprovalStatus.EXPIRED) throw new ApprovalExpiredError(approvalId)
      if (row.status !== ApprovalStatus.PENDING) {
        throw new ApprovalNotPendingError(approvalId, row.status)
      }

      const { count } = await tx.pendingApproval.updateMany({
        where: { id: approvalId, status: ApprovalStatus.PENDING },
        data: {
          status: ApprovalStatus.REJECTED,
          decidedBy: actor.id,
          decidedByRole: actor.role,
          decidedAt: now,
          decisionReason: reason,
        },
      })
      if (count === 0) throw new ApprovalNotPendingError(approvalId, 'decided')

      await this.audit(tx, actor, 'lifecycle.purge_rejected', row.resourceType, row.resourceId, {
        approvalId,
        reason,
        requestedBy: row.requestedBy,
      })

      return {
        ...row,
        status: ApprovalStatus.REJECTED,
        decidedBy: actor.id,
        decidedByRole: actor.role,
        decidedAt: now,
        decisionReason: reason,
      }
    })

    return toView(approval)
  }

  /**
   * Burns a lapsed approval BEFORE the decision transaction opens, not inside it. Marking
   * it expired and then throwing from the same transaction would roll the mark back, and
   * the row would come back to life as PENDING on the next attempt.
   */
  private async burnIfExpired(approvalId: string, now: Date): Promise<void> {
    await this.prisma.pendingApproval.updateMany({
      where: { id: approvalId, status: ApprovalStatus.PENDING, expiresAt: { lte: now } },
      data: { status: ApprovalStatus.EXPIRED },
    })
  }

  private async assertSecondApproverExists(actor: AuthUser): Promise<void> {
    const others = await this.prisma.user.count({
      where: {
        id: { not: actor.id },
        role: { in: PURGE_CAPABLE_PRISMA_ROLES },
        deletedAt: null,
        lifecycleStatus: LifecycleStatus.ACTIVE,
      },
    })
    if (others === 0) throw new PurgeApproverUnavailableError()
  }

  // A PENDING row past its TTL is dead but still occupies the partial unique index, which
  // would otherwise make the resource permanently un-requestable. Lapsing it here is what
  // keeps a fresh request possible without a sweeper.
  private async lapseExpired(
    tx: Prisma.TransactionClient,
    resourceType: string,
    resourceId: string,
    now: Date,
  ): Promise<void> {
    await tx.pendingApproval.updateMany({
      where: {
        action: PURGE_ACTION,
        resourceType,
        resourceId,
        status: ApprovalStatus.PENDING,
        expiresAt: { lte: now },
      },
      data: { status: ApprovalStatus.EXPIRED },
    })
  }

  // Filed against the RESOURCE, not against the approval row, so "everything that ever
  // happened to this facility" includes the purge that was asked for and the decision on
  // it. The approval id travels in the payload for the reverse lookup.
  private async audit(
    tx: Prisma.TransactionClient,
    actor: AuthUser,
    action: string,
    resourceType: string,
    resourceId: string,
    payload: Record<string, string>,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        actorId: actor.id,
        actorRole: actor.role,
        action,
        entityType: RESOURCE_ENTITY_TYPE[resourceType as LifecycleResourceType] ?? resourceType,
        entityId: resourceId,
        payload: { ...payload, resourceType },
        ipAddress: RequestContext.getIp(),
      },
    })
  }
}

function toView(approval: PendingApproval): ApprovalView {
  return {
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
  }
}
