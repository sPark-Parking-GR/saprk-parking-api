import { ForbiddenException, Injectable } from '@nestjs/common'
import {
  ApprovalStatus,
  LifecycleStatus,
  OperatorMemberRole,
  UserRole,
  type PendingApproval,
  type Prisma,
} from '@prisma/client'
import {
  hasPlatformPermission,
  USER_ROLES,
  type AuthUser,
  type UserRole as ContractRole,
} from '@spark/types'
import {
  ApprovalAlreadyPendingError,
  ApprovalExpiredError,
  ApprovalNotFoundError,
  ApprovalNotPendingError,
  SelfApprovalError,
} from '../common/errors/domain.errors'
import { PrismaService } from '../prisma/prisma.service'
import { recordAudit } from './identity.service'
import {
  IdentityUserNotFoundError,
  LastSuperAdminError,
  NotASuperAdminError,
  SelfRoleAssignmentError,
  SuperAdminApproverUnavailableError,
  type IdentityApprovalList,
  type IdentityApprovalView,
} from './identity.types'

/**
 * The one action permitted against a super administrator, and the only way the tier ever
 * shrinks. Deliberately singular: every ordinary verb refuses a super-admin target outright,
 * so there is exactly one path to reason about rather than an approval fork on each of
 * archive, tombstone, purge and re-role.
 *
 * Demotion strips PLATFORM authority only — the account survives, and falls back to whatever
 * its operator memberships already say.
 */
export const DEMOTE_ACTION = 'identity.super_admin_demote'

const RESOURCE_TYPE = 'user'

/** Same 24h window as the purge rule: long enough to reach a peer, short enough not to sit. */
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000

const EVERY_STATUS: LifecycleStatus[] = [
  LifecycleStatus.ACTIVE,
  LifecycleStatus.ARCHIVED,
  LifecycleStatus.TOMBSTONED,
  LifecycleStatus.PURGED,
]

const TO_PRISMA_ROLE: Record<ContractRole, UserRole> = {
  guest: UserRole.USER,
  user: UserRole.USER,
  operator_staff: UserRole.OPERATOR_STAFF,
  operator_admin: UserRole.OPERATOR_ADMIN,
  platform_admin: UserRole.PLATFORM_ADMIN,
  super_admin: UserRole.SUPER_ADMIN,
}

/**
 * Who may redeem a demotion. Derived from the permission map rather than hardcoded to
 * SUPER_ADMIN, so a second role granted identity:role.assign would automatically count
 * towards the two-person rule instead of silently not counting.
 */
const APPROVER_ROLES = [
  ...new Set(
    USER_ROLES.filter((role) => hasPlatformPermission(role, 'identity:role.assign')).map(
      (role) => TO_PRISMA_ROLE[role],
    ),
  ),
]

/**
 * The two-person rule over super administrators.
 *
 * Mirrors LifecycleApprovalService rather than extending it. That service is working,
 * tested and load-bearing for purges; its approver set is platform:tenant.purge holders and
 * its audit vocabulary is purge-specific, and threading two more parameters through it to
 * serve a second caller would make the purge path harder to read for no benefit here.
 *
 * FAILS CLOSED WITH ONE SUPER ADMIN. A lone super admin cannot demote anyone, including
 * themselves — self-demotion is refused separately, because an account that can strip its
 * own tier can be coerced into doing so.
 */
@Injectable()
export class IdentityApprovalService {
  constructor(private readonly prisma: PrismaService) {}

  async requestDemotion(actor: AuthUser, userId: string, reason: string): Promise<IdentityApprovalView> {
    this.assertMayAssign(actor)
    if (actor.id === userId) throw new SelfRoleAssignmentError()

    const target = await this.prisma.user.findFirst({
      where: { id: userId, lifecycleStatus: { in: EVERY_STATUS } },
      select: { role: true },
    })
    if (!target) throw new IdentityUserNotFoundError(userId)
    if (target.role !== UserRole.SUPER_ADMIN) throw new NotASuperAdminError()

    await this.assertAnotherSuperAdminExists(actor.id)
    await this.assertNotTheLastSuperAdmin(userId)

    const now = new Date()
    const approval = await this.prisma.$transaction(async (tx) => {
      await this.lapseExpired(tx, userId, now)

      const live = await tx.pendingApproval.findFirst({
        where: {
          action: DEMOTE_ACTION,
          resourceType: RESOURCE_TYPE,
          resourceId: userId,
          status: ApprovalStatus.PENDING,
        },
        select: { id: true },
      })
      if (live) throw new ApprovalAlreadyPendingError(live.id)

      const created = await tx.pendingApproval.create({
        data: {
          action: DEMOTE_ACTION,
          resourceType: RESOURCE_TYPE,
          resourceId: userId,
          reason,
          requestedBy: actor.id,
          requestedByRole: actor.role,
          expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS),
        },
      })

      await recordAudit(tx, actor, 'user.demotion_requested', userId, {
        approvalId: created.id,
        reason,
        expiresAt: created.expiresAt.toISOString(),
      })

      return created
    })

    return toView(approval)
  }

  async list(actor: AuthUser): Promise<IdentityApprovalList> {
    this.assertMayAssign(actor)

    const items = await this.prisma.pendingApproval.findMany({
      where: {
        action: DEMOTE_ACTION,
        status: ApprovalStatus.PENDING,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    })
    return { items: items.map(toView), total: items.length }
  }

  /**
   * Claims the approval and performs the demotion in ONE transaction, unlike the purge rule
   * which separates them. A purge may touch thousands of rows and must not hold the approval
   * lock while it does; a demotion is a single-row update, so the simpler atomic version is
   * both available and safer — there is no window in which the approval is spent but the
   * role never changed.
   */
  async approve(actor: AuthUser, approvalId: string): Promise<IdentityApprovalView> {
    this.assertMayAssign(actor)

    const now = new Date()
    await this.burnIfExpired(approvalId, now)

    const decided = await this.prisma.$transaction(async (tx) => {
      const approval = await tx.pendingApproval.findUnique({ where: { id: approvalId } })
      if (!approval) throw new ApprovalNotFoundError(approvalId)
      if (approval.action !== DEMOTE_ACTION) throw new ApprovalNotFoundError(approvalId)
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

      await this.demote(tx, actor, approval.resourceId, approval)

      return {
        ...approval,
        status: ApprovalStatus.APPROVED,
        decidedBy: actor.id,
        decidedByRole: actor.role,
        decidedAt: now,
      }
    })

    return toView(decided)
  }

  /** Open to the requester too: withdrawing your own request removes a capability. */
  async reject(actor: AuthUser, approvalId: string, reason: string): Promise<IdentityApprovalView> {
    this.assertMayAssign(actor)

    const now = new Date()
    await this.burnIfExpired(approvalId, now)

    const decided = await this.prisma.$transaction(async (tx) => {
      const approval = await tx.pendingApproval.findUnique({ where: { id: approvalId } })
      if (!approval || approval.action !== DEMOTE_ACTION) {
        throw new ApprovalNotFoundError(approvalId)
      }
      if (approval.status === ApprovalStatus.EXPIRED) throw new ApprovalExpiredError(approvalId)
      if (approval.status !== ApprovalStatus.PENDING) {
        throw new ApprovalNotPendingError(approvalId, approval.status)
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

      await recordAudit(tx, actor, 'user.demotion_rejected', approval.resourceId, {
        approvalId,
        reason,
        requestedBy: approval.requestedBy,
      })

      return {
        ...approval,
        status: ApprovalStatus.REJECTED,
        decidedBy: actor.id,
        decidedByRole: actor.role,
        decidedAt: now,
        decisionReason: reason,
      }
    })

    return toView(decided)
  }

  private async demote(
    tx: Prisma.TransactionClient,
    actor: AuthUser,
    userId: string,
    approval: PendingApproval,
  ): Promise<void> {
    const target = await tx.user.findFirst({
      where: { id: userId, lifecycleStatus: { in: EVERY_STATUS } },
      select: { role: true, operatorMemberships: { select: { role: true } } },
    })
    if (!target) throw new IdentityUserNotFoundError(userId)
    // Re-checked at redemption, not only at request: the tier can shrink in the 24 hours
    // between the two, and the last super admin must survive either way.
    if (target.role !== UserRole.SUPER_ADMIN) throw new NotASuperAdminError()
    await this.assertNotTheLastSuperAdmin(userId, tx)

    const next = target.operatorMemberships.some((m) => m.role === OperatorMemberRole.ADMIN)
      ? UserRole.OPERATOR_ADMIN
      : target.operatorMemberships.length > 0
        ? UserRole.OPERATOR_STAFF
        : UserRole.USER

    await tx.user.update({
      where: { id: userId },
      data: { role: next, sessionsValidFrom: new Date() },
    })

    await recordAudit(tx, actor, 'user.demoted', userId, {
      approvalId: approval.id,
      from: UserRole.SUPER_ADMIN,
      to: next,
      reason: approval.reason,
      requestedBy: approval.requestedBy,
    })
  }

  private async assertNotTheLastSuperAdmin(
    userId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = tx ?? this.prisma
    const others = await client.user.count({
      where: {
        id: { not: userId },
        role: UserRole.SUPER_ADMIN,
        deletedAt: null,
        lifecycleStatus: LifecycleStatus.ACTIVE,
      },
    })
    if (others === 0) throw new LastSuperAdminError()
  }

  private async assertAnotherSuperAdminExists(actorId: string): Promise<void> {
    const others = await this.prisma.user.count({
      where: {
        id: { not: actorId },
        role: { in: APPROVER_ROLES },
        deletedAt: null,
        lifecycleStatus: LifecycleStatus.ACTIVE,
      },
    })
    if (others === 0) throw new SuperAdminApproverUnavailableError()
  }

  private async lapseExpired(
    tx: Prisma.TransactionClient,
    userId: string,
    now: Date,
  ): Promise<void> {
    await tx.pendingApproval.updateMany({
      where: {
        action: DEMOTE_ACTION,
        resourceType: RESOURCE_TYPE,
        resourceId: userId,
        status: ApprovalStatus.PENDING,
        expiresAt: { lte: now },
      },
      data: { status: ApprovalStatus.EXPIRED },
    })
  }

  // Burned BEFORE the decision transaction opens: marking it expired inside the same
  // transaction that then throws would roll the mark back, and the row would revive.
  private async burnIfExpired(approvalId: string, now: Date): Promise<void> {
    await this.prisma.pendingApproval.updateMany({
      where: { id: approvalId, status: ApprovalStatus.PENDING, expiresAt: { lte: now } },
      data: { status: ApprovalStatus.EXPIRED },
    })
  }

  private assertMayAssign(actor: AuthUser): void {
    // Controller already gates on the same permission; re-check in the service layer per
    // the both-layers authorization rule.
    if (!hasPlatformPermission(actor.role, 'identity:role.assign')) {
      throw new ForbiddenException('Only super admins may demote a super administrator')
    }
  }
}

function toView(approval: PendingApproval): IdentityApprovalView {
  return {
    id: approval.id,
    action: approval.action,
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
