import { ForbiddenException, Injectable } from '@nestjs/common'
import { OperatorMemberRole, OperatorStatus, UserRole, type Prisma } from '@prisma/client'
import type { AuthUser } from '@spark/types'
import { RequestContext } from '../common/context/request-context'
import { PrismaService } from '../prisma/prisma.service'
import { OperatorAccessService } from './operator-access.service'
import {
  LastOperatorAdminError,
  OperatorMemberNotFoundError,
  SelfMembershipRemovalError,
  SelfRoleChangeError,
  type OperatorMemberSummary,
} from './operators.types'

@Injectable()
export class OperatorMembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OperatorAccessService,
  ) {}

  async list(actor: AuthUser, requestedOperatorId: string): Promise<OperatorMemberSummary[]> {
    const operatorId = await this.assertMayManage(actor, requestedOperatorId)

    const memberships = await this.prisma.operatorMembership.findMany({
      where: { operatorId },
      select: { userId: true, role: true, createdAt: true, user: { select: { email: true } } },
      orderBy: { createdAt: 'asc' },
    })

    return memberships.map((m) => ({
      userId: m.userId,
      email: m.user.email,
      role: m.role,
      createdAt: m.createdAt,
    }))
  }

  async changeRole(
    actor: AuthUser,
    requestedOperatorId: string,
    userId: string,
    role: OperatorMemberRole,
  ): Promise<OperatorMemberSummary> {
    const operatorId = await this.assertMayManage(actor, requestedOperatorId)

    // An admin must not be able to write themselves out of their own admin rights: the
    // only legitimate self-change is a demotion, and it would leave nobody holding the
    // authority to undo it if it was a mistake.
    if (userId === actor.id) throw new SelfRoleChangeError()

    return this.prisma.$transaction(async (tx) => {
      await this.lockOperator(tx, operatorId)

      const membership = await this.findMembership(tx, operatorId, userId)

      if (membership.role !== role) {
        if (membership.role === OperatorMemberRole.ADMIN) {
          await this.guardLastAdminLoss(tx, operatorId, userId)
        }

        await tx.operatorMembership.update({ where: { id: membership.id }, data: { role } })
        await this.reconcileUserRole(tx, userId)
        await this.recordAudit(tx, actor, 'operator_member.role_changed', membership.id, {
          operatorId,
          userId,
          from: membership.role,
          to: role,
        })
      }

      return {
        userId,
        email: membership.user.email,
        role,
        createdAt: membership.createdAt,
      }
    })
  }

  async remove(actor: AuthUser, requestedOperatorId: string, userId: string): Promise<void> {
    const operatorId = await this.assertMayManage(actor, requestedOperatorId)

    if (userId === actor.id) throw new SelfMembershipRemovalError()

    await this.prisma.$transaction(async (tx) => {
      await this.lockOperator(tx, operatorId)

      const membership = await this.findMembership(tx, operatorId, userId)
      if (membership.role === OperatorMemberRole.ADMIN) {
        await this.guardLastAdminLoss(tx, operatorId, userId)
      }

      await tx.operatorMembership.delete({ where: { id: membership.id } })
      const revoked = await this.revokeManagedAssignments(tx, operatorId, userId)
      await this.reconcileUserRole(tx, userId)
      await this.recordAudit(tx, actor, 'operator_member.removed', membership.id, {
        operatorId,
        userId,
        role: membership.role,
        ...revoked,
      })
    })
  }

  private async assertMayManage(actor: AuthUser, requestedOperatorId: string): Promise<string> {
    // Controller already gates on @Roles('operator_admin', 'platform_admin'); re-check in
    // the service layer per the both-layers authorization rule. resolveAdministrable then
    // does the tenancy half — the role check alone says nothing about WHICH operator.
    if (actor.role !== 'operator_admin' && actor.role !== 'platform_admin') {
      throw new ForbiddenException('Only operator admins may manage operator members')
    }
    return this.access.resolveAdministrable(actor, requestedOperatorId)
  }

  // Serializes every membership mutation for one operator, so two concurrent demotions of
  // two different admins cannot both observe a surviving admin and both commit.
  private async lockOperator(tx: Prisma.TransactionClient, operatorId: string): Promise<void> {
    await tx.$executeRaw`SELECT id FROM "ParkingOperator" WHERE id = ${operatorId} FOR UPDATE`
  }

  private async findMembership(
    tx: Prisma.TransactionClient,
    operatorId: string,
    userId: string,
  ): Promise<{
    id: string
    role: OperatorMemberRole
    createdAt: Date
    user: { email: string }
  }> {
    const membership = await tx.operatorMembership.findUnique({
      where: { operatorId_userId: { operatorId, userId } },
      select: { id: true, role: true, createdAt: true, user: { select: { email: true } } },
    })
    if (!membership) throw new OperatorMemberNotFoundError(userId)
    return membership
  }

  private async guardLastAdminLoss(
    tx: Prisma.TransactionClient,
    operatorId: string,
    userId: string,
  ): Promise<void> {
    const operator = await tx.parkingOperator.findUnique({
      where: { id: operatorId },
      select: { status: true },
    })
    // Only a live operator has anything to lose. A PENDING shell has no members to strand,
    // and a SUSPENDED one already needs platform intervention to be usable again — the
    // same intervention that would restore a missing admin.
    if (operator?.status !== OperatorStatus.VERIFIED) return

    const remainingAdmins = await tx.operatorMembership.count({
      where: { operatorId, role: OperatorMemberRole.ADMIN, userId: { not: userId } },
    })
    if (remainingAdmins === 0) throw new LastOperatorAdminError(operatorId)
  }

  /**
   * A management assignment must not outlive the membership it hangs off. The manager
   * predicate is `operator IN scope AND assigned to me`, so a removed member is already
   * shut out by the operator half — but the rows would sit there as live grants waiting to
   * take effect the moment the same person was invited back, which is not what anyone
   * re-inviting them would be agreeing to. Deleted in the same transaction as the
   * membership so the two can never disagree.
   *
   * Scoped to THIS operator's resources only: a multi-operator user keeps everything they
   * manage elsewhere. Archived facilities and plans are included — the relation filter is
   * not touched by the lifecycle extension, which is what we want here, since a restore
   * must not quietly hand access back to someone who has since left.
   */
  private async revokeManagedAssignments(
    tx: Prisma.TransactionClient,
    operatorId: string,
    userId: string,
  ): Promise<{ facilitiesRevoked: number; tariffPlansRevoked: number }> {
    // Sequential, not Promise.all: an interactive transaction is one connection, and every
    // other write in this service queues on it the same way.
    const facilities = await tx.facilityManager.deleteMany({
      where: { userId, facility: { operatorId } },
    })
    const tariffPlans = await tx.tariffPlanManager.deleteMany({
      where: { userId, tariffPlan: { operatorId } },
    })
    return { facilitiesRevoked: facilities.count, tariffPlansRevoked: tariffPlans.count }
  }

  /**
   * Realigns the global User.role with the memberships that now exist, and moves the
   * session revocation watermark.
   *
   * The watermark bump is the point: User.role and OperatorMembership.role both feed
   * authorization, but a demoted admin holding a live 15-minute access token would keep
   * every admin right the token was minted with until it expired. sessionsValidFrom is the
   * only revocation channel that reaches Firebase-issued tokens too, since we cannot edit
   * their claims. It is moved whenever the membership changed at all, not only when the
   * derived global role changed, because per-operator authority changed either way.
   */
  private async reconcileUserRole(tx: Prisma.TransactionClient, userId: string): Promise<void> {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { role: true } })
    if (!user) return

    const data: Prisma.UserUpdateInput = { sessionsValidFrom: new Date() }

    // A platform admin's role is not derived from operator memberships and must never be
    // downgraded by losing one.
    if (user.role !== UserRole.PLATFORM_ADMIN) {
      const memberships = await tx.operatorMembership.findMany({
        where: { userId },
        select: { role: true },
      })
      data.role = memberships.some((m) => m.role === OperatorMemberRole.ADMIN)
        ? UserRole.OPERATOR_ADMIN
        : memberships.length > 0
          ? UserRole.OPERATOR_STAFF
          : UserRole.USER
    }

    await tx.user.update({ where: { id: userId }, data })
  }

  private async recordAudit(
    tx: Prisma.TransactionClient,
    actor: AuthUser,
    action: string,
    membershipId: string,
    payload: Prisma.InputJsonValue,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        actorId: actor.id,
        actorRole: actor.role,
        action,
        entityType: 'OperatorMembership',
        entityId: membershipId,
        payload,
        ipAddress: RequestContext.getIp(),
      },
    })
  }
}
