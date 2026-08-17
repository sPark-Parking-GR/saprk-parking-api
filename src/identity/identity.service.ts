import { ForbiddenException, Injectable } from '@nestjs/common'
import { LifecycleStatus, OperatorMemberRole, UserRole, type Prisma } from '@prisma/client'
import { hasPlatformPermission, type AuthUser, type PlatformPermission } from '@spark/types'
import { RequestContext } from '../common/context/request-context'
import { PrismaService } from '../prisma/prisma.service'
import { ASSIGNABLE_ROLES, type AssignRoleDto, type ListUsersDto } from './dto/identity.dto'
import {
  AnonymisedAccountError,
  IdentityUserNotFoundError,
  SelfRoleAssignmentError,
  SuperAdminProtectedError,
  type IdentityUserDetail,
  type IdentityUserPage,
  type IdentityUserSummary,
} from './identity.types'

/**
 * Named in full rather than omitted, because naming lifecycleStatus at the top level is the
 * Prisma lifecycle extension's documented opt-out. Without it every read here would be
 * silently narrowed to ACTIVE, and a directory whose whole purpose is to find suspended and
 * deleted accounts would be unable to see them.
 */
const EVERY_STATUS: LifecycleStatus[] = [
  LifecycleStatus.ACTIVE,
  LifecycleStatus.ARCHIVED,
  LifecycleStatus.TOMBSTONED,
  LifecycleStatus.PURGED,
]

const SUMMARY_SELECT = {
  id: true,
  email: true,
  displayName: true,
  role: true,
  emailVerified: true,
  lifecycleStatus: true,
  deletedAt: true,
  createdAt: true,
  operatorMemberships: {
    select: { role: true, operator: { select: { id: true, name: true } } },
  },
} satisfies Prisma.UserSelect

type SummaryRow = Prisma.UserGetPayload<{ select: typeof SUMMARY_SELECT }>

/**
 * The user directory. The lifecycle VERBS already existed and were correct; what was
 * missing was any way to find the account to point them at, which is all this adds.
 *
 * Every method re-checks the permission its controller already gated on, per the
 * both-layers rule. That gate is identity:user.read, which platform admins do not hold —
 * this surface is super-admin-only in its entirety.
 */
@Injectable()
export class IdentityService {
  constructor(private readonly prisma: PrismaService) {}

  async list(actor: AuthUser, query: ListUsersDto): Promise<IdentityUserPage> {
    this.assertPermission(actor, 'identity:user.read', 'browse user accounts')

    const where = this.whereFor(query)
    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: SUMMARY_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: query.skip,
        take: query.take,
      }),
      this.prisma.user.count({ where }),
    ])

    return {
      items: rows.map(toSummary),
      total,
      skip: query.skip,
      take: query.take,
    }
  }

  async get(actor: AuthUser, userId: string): Promise<IdentityUserDetail> {
    this.assertPermission(actor, 'identity:user.read', 'read a user account')

    const row = await this.prisma.user.findFirst({
      where: { id: userId, lifecycleStatus: { in: EVERY_STATUS } },
      select: {
        ...SUMMARY_SELECT,
        updatedAt: true,
        sessionsValidFrom: true,
        lifecycleChangedAt: true,
        lifecycleChangedBy: true,
        lifecycleReason: true,
        purgeAfter: true,
      },
    })
    if (!row) throw new IdentityUserNotFoundError(userId)

    // entityType is passed alongside entityId deliberately: the audit index is composite on
    // (entityType, entityId), and querying by id alone falls back to a sequential scan.
    const activity = await this.prisma.auditLog.findMany({
      where: { entityType: 'User', entityId: userId },
      select: { id: true, action: true, actorId: true, actorRole: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 20,
    })

    return {
      ...toSummary(row),
      updatedAt: row.updatedAt.toISOString(),
      sessionsValidFrom: row.sessionsValidFrom?.toISOString() ?? null,
      lifecycleChangedAt: row.lifecycleChangedAt?.toISOString() ?? null,
      lifecycleChangedBy: row.lifecycleChangedBy,
      lifecycleReason: row.lifecycleReason,
      purgeAfter: row.purgeAfter?.toISOString() ?? null,
      recentActivity: activity.map((entry) => ({
        id: entry.id,
        action: entry.action,
        actorId: entry.actorId,
        actorRole: entry.actorRole,
        createdAt: entry.createdAt.toISOString(),
      })),
    }
  }

  /**
   * Grants or revokes PLATFORM authority. Refuses to act on a super admin at all — that is
   * the demotion flow's job, and it needs a second super admin to agree.
   */
  async assignRole(actor: AuthUser, userId: string, dto: AssignRoleDto): Promise<void> {
    this.assertPermission(actor, 'identity:role.assign', 'change a platform role')
    if (actor.id === userId) throw new SelfRoleAssignmentError()

    await this.prisma.$transaction(async (tx) => {
      const target = await tx.user.findFirst({
        where: { id: userId, lifecycleStatus: { in: EVERY_STATUS } },
        select: { id: true, role: true, deletedAt: true, operatorMemberships: { select: { role: true } } },
      })
      if (!target) throw new IdentityUserNotFoundError(userId)
      if (target.deletedAt) throw new AnonymisedAccountError()
      if (target.role === UserRole.SUPER_ADMIN) throw new SuperAdminProtectedError('re-roled')

      const next = resolveAssignedRole(dto.role, target.operatorMemberships)
      if (next === target.role) return

      await tx.user.update({
        where: { id: userId },
        // Platform authority changed, so every token minted under the old role has to die.
        // Same watermark reconcileUserRole moves for the operator axis.
        data: { role: next, sessionsValidFrom: new Date() },
      })

      await recordAudit(tx, actor, 'user.role_changed', userId, {
        from: target.role,
        to: next,
        requested: dto.role,
        reason: dto.reason,
      })
    })
  }

  private whereFor(query: ListUsersDto): Prisma.UserWhereInput {
    const filters: Prisma.UserWhereInput[] = []

    if (query.q) {
      filters.push({
        OR: [
          { email: { contains: query.q, mode: 'insensitive' } },
          { displayName: { contains: query.q, mode: 'insensitive' } },
        ],
      })
    }
    if (query.role) filters.push({ role: query.role })
    if (query.operatorId) {
      filters.push({ operatorMemberships: { some: { operatorId: query.operatorId } } })
    }

    return {
      lifecycleStatus: query.lifecycleStatus ?? { in: EVERY_STATUS },
      ...(filters.length > 0 ? { AND: filters } : {}),
    }
  }

  private assertPermission(actor: AuthUser, permission: PlatformPermission, action: string): void {
    // Controller already gates on the same permission; re-check in the service layer per
    // the both-layers authorization rule.
    if (!hasPlatformPermission(actor.role, permission)) {
      throw new ForbiddenException(`Only super admins may ${action}`)
    }
  }
}

/**
 * Revoking platform authority means falling back to whatever operator membership already
 * says, NOT to USER flat. reconcileUserRole owns that derivation for the operator axis, and
 * writing USER over an account that still administers an operator would put the two axes
 * out of sync until the next membership change silently corrected it.
 */
function resolveAssignedRole(
  requested: (typeof ASSIGNABLE_ROLES)[number],
  memberships: { role: OperatorMemberRole }[],
): UserRole {
  if (requested !== UserRole.USER) return requested
  if (memberships.some((m) => m.role === OperatorMemberRole.ADMIN)) return UserRole.OPERATOR_ADMIN
  return memberships.length > 0 ? UserRole.OPERATOR_STAFF : UserRole.USER
}

// Written inside the caller's transaction so the trail commits with the change, and pulling
// the IP from request context rather than threading it through — the convention every other
// writer in this codebase follows.
export async function recordAudit(
  tx: Prisma.TransactionClient,
  actor: AuthUser,
  action: string,
  userId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await tx.auditLog.create({
    data: {
      actorId: actor.id,
      actorRole: actor.role,
      action,
      entityType: 'User',
      entityId: userId,
      payload: payload as Prisma.InputJsonValue,
      ipAddress: RequestContext.getIp(),
    },
  })
}

function toSummary(row: SummaryRow): IdentityUserSummary {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
    emailVerified: row.emailVerified,
    lifecycleStatus: row.lifecycleStatus,
    anonymisedAt: row.deletedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    memberships: row.operatorMemberships.map((membership) => ({
      operatorId: membership.operator.id,
      operatorName: membership.operator.name,
      role: membership.role,
    })),
  }
}
