import { ForbiddenException, Injectable } from '@nestjs/common'
import { LifecycleStatus, UserRole, type OperatorMemberRole, type Prisma } from '@prisma/client'
import { isPlatformRole, type AuthUser } from '@spark/types'
import { OperatorScopeService } from '../common/authz/operator-scope.service'
import { RequestContext } from '../common/context/request-context'
import {
  FacilityHasNoOperatorError,
  FacilityNotFoundError,
  ManagerAssignmentRejectedError,
  TariffPlanNotFoundError,
} from '../common/errors/domain.errors'
import { OperatorAccessService } from '../operators/operator-access.service'
import { PrismaService } from '../prisma/prisma.service'
import type { ManagerCandidate, ResourceManager, ResourceManagers } from './managers.types'

interface MemberInfo {
  memberRole: OperatorMemberRole
  email: string
  displayName: string | null
  eligible: boolean
}

/** The diff a replace actually applied, as the audit payload records it. */
interface ManagerDelta {
  added: string[]
  removed: string[]
}

/**
 * Reads and rewrites who manages one facility or one tariff plan.
 *
 * Lives outside FacilitiesService/TariffService because it is the one operator-facing
 * surface that must NOT be narrowed by the management assignment it administers: an
 * operator admin has to be able to grant a resource nobody is assigned to yet, and could
 * never bootstrap out of an empty state if the endpoint filtered on the very rows it
 * exists to create.
 */
@Injectable()
export class ResourceManagersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operatorScope: OperatorScopeService,
    private readonly access: OperatorAccessService,
  ) {}

  async listFacilityManagers(actor: AuthUser, facilityId: string): Promise<ResourceManagers> {
    const operatorId = await this.resolveFacilityOperator(actor, facilityId)
    return this.render(facilityId, operatorId, await this.facilityManagerRows(facilityId))
  }

  async replaceFacilityManagers(
    actor: AuthUser,
    facilityId: string,
    userIds: string[],
  ): Promise<ResourceManagers> {
    const operatorId = await this.resolveFacilityOperator(actor, facilityId)

    await this.prisma.$transaction(async (tx) => {
      // Validated INSIDE the transaction. OperatorMembersService.remove takes a row lock on
      // the operator and deletes memberships under it; validating outside this transaction
      // leaves a window in which a membership ending concurrently still produces a grant
      // for a non-member — dormant while they are out, live again the moment they are
      // re-invited, which is exactly what that removal path revokes to prevent.
      const requested = await this.validateRequested(tx, operatorId, userIds)

      const current = await tx.facilityManager.findMany({
        where: { facilityId },
        select: { userId: true },
      })
      const { added, removed } = delta(
        current.map((r) => r.userId),
        requested,
      )

      if (removed.length > 0) {
        await tx.facilityManager.deleteMany({ where: { facilityId, userId: { in: removed } } })
      }
      if (added.length > 0) {
        await tx.facilityManager.createMany({
          data: added.map((userId) => ({ facilityId, userId, assignedBy: actor.id })),
        })
      }

      await this.recordAudit(tx, actor, 'facility.managers_changed', 'Facility', facilityId, {
        added,
        removed,
      })
    })

    return this.render(facilityId, operatorId, await this.facilityManagerRows(facilityId))
  }

  async listTariffPlanManagers(actor: AuthUser, planId: string): Promise<ResourceManagers> {
    const operatorId = await this.resolveTariffPlanOperator(actor, planId)
    return this.render(planId, operatorId, await this.tariffPlanManagerRows(planId))
  }

  async replaceTariffPlanManagers(
    actor: AuthUser,
    planId: string,
    userIds: string[],
  ): Promise<ResourceManagers> {
    const operatorId = await this.resolveTariffPlanOperator(actor, planId)

    await this.prisma.$transaction(async (tx) => {
      // Validated inside the transaction — see replaceFacilityManagers for why.
      const requested = await this.validateRequested(tx, operatorId, userIds)

      const current = await tx.tariffPlanManager.findMany({
        where: { tariffPlanId: planId },
        select: { userId: true },
      })
      const { added, removed } = delta(
        current.map((r) => r.userId),
        requested,
      )

      if (removed.length > 0) {
        await tx.tariffPlanManager.deleteMany({
          where: { tariffPlanId: planId, userId: { in: removed } },
        })
      }
      if (added.length > 0) {
        await tx.tariffPlanManager.createMany({
          data: added.map((userId) => ({ tariffPlanId: planId, userId, assignedBy: actor.id })),
        })
      }

      await this.recordAudit(tx, actor, 'tariff_plan.managers_changed', 'TariffPlan', planId, {
        added,
        removed,
      })
    })

    return this.render(planId, operatorId, await this.tariffPlanManagerRows(planId))
  }

  /**
   * Resolves the facility to its owning operator and authorizes the caller against it.
   *
   * A resource outside the caller's operators gets the SAME not-found a fabricated id gets,
   * so another tenant's ids cannot be probed for existence. Inside an operator the caller
   * already belongs to but only as STAFF, resolveAdministrable answers 403 instead — the
   * existing precedent for member and invite management, and no leak, because the caller
   * can already enumerate that operator's resources through their own dashboard.
   *
   * Deliberately the plain operator scope, NOT facilityScopeWhere: this endpoint
   * administers the management assignment, so filtering by it would make an unassigned
   * resource unassignable and leave a tenant permanently stuck.
   */
  private async resolveFacilityOperator(actor: AuthUser, facilityId: string): Promise<string> {
    const scope = await this.operatorScope.resolve(actor)
    const facility = await this.prisma.facility.findFirst({
      where: { id: facilityId, ...this.operatorScope.scopeWhere(scope) },
      select: { operatorId: true },
    })
    if (!facility) throw new FacilityNotFoundError(facilityId)
    if (facility.operatorId === null) throw new FacilityHasNoOperatorError(facilityId)

    return this.assertMayAdminister(actor, facility.operatorId)
  }

  private async resolveTariffPlanOperator(actor: AuthUser, planId: string): Promise<string> {
    const scope = await this.operatorScope.resolve(actor)
    const plan = await this.prisma.tariffPlan.findFirst({
      where: { id: planId, ...this.operatorScope.scopeWhere(scope) },
      select: { operatorId: true },
    })
    if (!plan) throw new TariffPlanNotFoundError(planId)

    return this.assertMayAdminister(actor, plan.operatorId)
  }

  /**
   * Platform admin, or an ADMIN member of the owning operator. Re-checked here even though
   * the controller carries @Roles, per the both-layers rule — the role check alone says
   * nothing about WHICH operator, which is the half that matters.
   *
   * NOTE, and this is a deliberate trade-off rather than an oversight: an operator admin
   * may assign ANY resource in their own operator to ANYONE, including themselves. So the
   * per-user restriction does not constrain an operator admin within their own tenant — it
   * constrains operator_staff, and it constrains everyone across tenants. That is the price
   * of letting a tenant delegate to its own staff without a platform admin in the loop, and
   * it is why this endpoint is on the resource rather than under /admin.
   */
  private async assertMayAdminister(actor: AuthUser, operatorId: string): Promise<string> {
    if (actor.role !== 'operator_admin' && !isPlatformRole(actor.role)) {
      throw new ForbiddenException('Only operator admins may manage resource assignments')
    }
    return this.access.resolveAdministrable(actor, operatorId)
  }

  /**
   * Every requested id must currently be a member of the OWNING operator and hold an
   * operator role. Rejects the whole request rather than dropping the bad ids: a partial
   * apply would report a grant that did not happen. Two separate refusals so the caller
   * learns which rule they broke.
   *
   * Platform admins are refused as assignees because they already see everything — a row
   * for one would grant nothing and would survive as a misleading claim that it did.
   * Consumer accounts are refused because they cannot reach an operator surface at all.
   */
  private async validateRequested(
    client: Prisma.TransactionClient,
    operatorId: string,
    userIds: string[],
  ): Promise<string[]> {
    const requested = [...new Set(userIds)]
    if (requested.length === 0) return requested

    const members = await this.members(client, operatorId)

    const notMembers = requested.filter((id) => !members.has(id))
    if (notMembers.length > 0) {
      throw new ManagerAssignmentRejectedError('not a member of the owning operator', notMembers)
    }

    const ineligible = requested.filter((id) => !members.get(id)?.eligible)
    if (ineligible.length > 0) {
      throw new ManagerAssignmentRejectedError(
        'platform admins and consumer accounts cannot be assigned',
        ineligible,
      )
    }

    return requested
  }

  /**
   * Every member of the operator, each flagged for whether they may hold an assignment.
   * The whole set is loaded rather than only the eligible ones so a manager row can still
   * be rendered with its member role if the person later became ineligible.
   *
   * The lifecycle terms are explicit because the default lifecycle filter does not reach
   * through a relation filter: without them an archived or tombstoned account would show up
   * as an assignable candidate.
   */
  private async members(
    client: Prisma.TransactionClient,
    operatorId: string,
  ): Promise<Map<string, MemberInfo>> {
    const rows = await client.operatorMembership.findMany({
      where: { operatorId },
      select: {
        userId: true,
        role: true,
        user: {
          select: {
            email: true,
            displayName: true,
            role: true,
            lifecycleStatus: true,
            deletedAt: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    })

    return new Map(
      rows.map((row) => [
        row.userId,
        {
          memberRole: row.role,
          email: row.user.email,
          displayName: row.user.displayName,
          eligible:
            (row.user.role === UserRole.OPERATOR_ADMIN ||
              row.user.role === UserRole.OPERATOR_STAFF) &&
            row.user.lifecycleStatus === LifecycleStatus.ACTIVE &&
            row.user.deletedAt === null,
        },
      ]),
    )
  }

  private facilityManagerRows(facilityId: string) {
    return this.prisma.facilityManager.findMany({
      where: { facilityId },
      select: {
        userId: true,
        assignedAt: true,
        assignedBy: true,
        user: { select: { email: true, displayName: true } },
      },
      orderBy: { assignedAt: 'asc' },
    })
  }

  private tariffPlanManagerRows(tariffPlanId: string) {
    return this.prisma.tariffPlanManager.findMany({
      where: { tariffPlanId },
      select: {
        userId: true,
        assignedAt: true,
        assignedBy: true,
        user: { select: { email: true, displayName: true } },
      },
      orderBy: { assignedAt: 'asc' },
    })
  }

  private async render(
    resourceId: string,
    operatorId: string,
    rows: Array<{
      userId: string
      assignedAt: Date
      assignedBy: string
      user: { email: string; displayName: string | null }
    }>,
  ): Promise<ResourceManagers> {
    const members = await this.members(this.prisma, operatorId)

    const managers: ResourceManager[] = rows.map((row) => ({
      userId: row.userId,
      email: row.user.email,
      displayName: row.user.displayName,
      memberRole: members.get(row.userId)?.memberRole ?? null,
      assignedAt: row.assignedAt,
      assignedBy: row.assignedBy,
    }))

    const candidates: ManagerCandidate[] = []
    for (const [userId, member] of members) {
      if (!member.eligible) continue
      candidates.push({
        userId,
        email: member.email,
        displayName: member.displayName,
        memberRole: member.memberRole,
      })
    }

    return { resourceId, operatorId, managers, candidates }
  }

  private async recordAudit(
    tx: Prisma.TransactionClient,
    actor: AuthUser,
    action: string,
    entityType: string,
    entityId: string,
    payload: ManagerDelta,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        actorId: actor.id,
        actorRole: actor.role,
        action,
        entityType,
        entityId,
        payload: { ...payload },
        ipAddress: RequestContext.getIp(),
      },
    })
  }
}

function delta(current: string[], requested: string[]): ManagerDelta {
  const before = new Set(current)
  const after = new Set(requested)
  return {
    added: requested.filter((id) => !before.has(id)),
    removed: current.filter((id) => !after.has(id)),
  }
}
