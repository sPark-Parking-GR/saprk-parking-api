import { ForbiddenException, Injectable } from '@nestjs/common'
import { OperatorStatus, type Prisma } from '@prisma/client'
import { hasPlatformPermission, type AuthUser, type PlatformPermission } from '@spark/types'
import { RequestContext } from '../common/context/request-context'
import { UNCLAIMED_OPERATOR_ID } from '../ingestion/ingestion.constants'
import { PrismaService } from '../prisma/prisma.service'
import {
  OperatorNotFoundError,
  OperatorNotReactivatableError,
  OperatorNotSuspendableError,
  type OperatorDetail,
  type OperatorSummary,
} from './operators.types'

@Injectable()
export class OperatorsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(actor: AuthUser): Promise<OperatorSummary[]> {
    this.assertPermission(actor, 'platform:tenant.read', 'view operators')

    // The synthetic operator owning un-onboarded OSM/Google imports is an ingestion
    // artifact, not a business — it must never be offered as suspendable.
    const operators = await this.prisma.parkingOperator.findMany({
      where: { id: { not: UNCLAIMED_OPERATOR_ID } },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { facilities: true, memberships: true } } },
    })

    return operators.map((operator) => ({
      id: operator.id,
      name: operator.name,
      status: operator.status,
      lifecycleStatus: operator.lifecycleStatus,
      facilityCount: operator._count.facilities,
      memberCount: operator._count.memberships,
      createdAt: operator.createdAt,
    }))
  }

  async getDetail(actor: AuthUser, id: string): Promise<OperatorDetail> {
    this.assertPermission(actor, 'platform:tenant.read', 'view operator detail')

    // The synthetic unclaimed-import operator (see list()) has no real detail page.
    if (id === UNCLAIMED_OPERATOR_ID) throw new OperatorNotFoundError(id)

    const operator = await this.prisma.parkingOperator.findUnique({
      where: { id },
      include: {
        facilities: {
          select: {
            id: true,
            name: true,
            address: true,
            isActive: true,
            isVerified: true,
            kind: true,
          },
          orderBy: { createdAt: 'desc' },
        },
        tariffPlans: {
          select: { id: true, name: true, isActive: true, isDefault: true },
          orderBy: { createdAt: 'desc' },
        },
        memberships: {
          select: { userId: true, role: true, createdAt: true, user: { select: { email: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    })
    if (!operator) throw new OperatorNotFoundError(id)

    return {
      id: operator.id,
      name: operator.name,
      status: operator.status,
      lifecycleStatus: operator.lifecycleStatus,
      facilityCount: operator.facilities.length,
      memberCount: operator.memberships.length,
      createdAt: operator.createdAt,
      facilities: operator.facilities,
      plans: operator.tariffPlans,
      members: operator.memberships.map((m) => ({
        userId: m.userId,
        email: m.user.email,
        role: m.role,
        createdAt: m.createdAt,
      })),
    }
  }

  async suspend(actor: AuthUser, id: string): Promise<void> {
    this.assertPermission(actor, 'platform:tenant.write', 'suspend operators')

    const count = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.parkingOperator.updateMany({
        where: { id, status: OperatorStatus.VERIFIED },
        data: { status: OperatorStatus.SUSPENDED },
      })
      if (count > 0) await this.recordAudit(tx, actor, 'operator.suspended', id)
      return count
    })
    if (count === 0) await this.explainFailedTransition(id, OperatorStatus.VERIFIED)
  }

  async reactivate(actor: AuthUser, id: string): Promise<void> {
    this.assertPermission(actor, 'platform:tenant.write', 'reactivate operators')

    // verifiedAt is left untouched: it records the original verification, not this
    // restoration of access.
    const count = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.parkingOperator.updateMany({
        where: { id, status: OperatorStatus.SUSPENDED },
        data: { status: OperatorStatus.VERIFIED },
      })
      if (count > 0) await this.recordAudit(tx, actor, 'operator.reactivated', id)
      return count
    })
    if (count === 0) await this.explainFailedTransition(id, OperatorStatus.SUSPENDED)
  }

  private assertPermission(actor: AuthUser, permission: PlatformPermission, action: string): void {
    // Controller already gates on the same permission; re-check in the service layer per
    // the both-layers authorization rule.
    if (!hasPlatformPermission(actor.role, permission)) {
      throw new ForbiddenException(`Only platform admins may ${action}`)
    }
  }

  private async recordAudit(
    tx: Prisma.TransactionClient,
    actor: AuthUser,
    action: string,
    operatorId: string,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        actorId: actor.id,
        actorRole: actor.role,
        action,
        entityType: 'ParkingOperator',
        entityId: operatorId,
        ipAddress: RequestContext.getIp(),
      },
    })
  }

  private async explainFailedTransition(id: string, required: OperatorStatus): Promise<never> {
    const operator = await this.prisma.parkingOperator.findUnique({
      where: { id },
      select: { status: true },
    })
    if (!operator) throw new OperatorNotFoundError(id)
    throw required === OperatorStatus.VERIFIED
      ? new OperatorNotSuspendableError(operator.status)
      : new OperatorNotReactivatableError(operator.status)
  }
}
