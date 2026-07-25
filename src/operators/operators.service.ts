import { ForbiddenException, Injectable } from '@nestjs/common'
import { OperatorStatus } from '@prisma/client'
import type { AuthUser } from '@spark/types'
import { UNCLAIMED_OPERATOR_ID } from '../ingestion/ingestion.constants'
import { PrismaService } from '../prisma/prisma.service'
import {
  OperatorNotFoundError,
  OperatorNotReactivatableError,
  OperatorNotSuspendableError,
  type OperatorSummary,
} from './operators.types'

@Injectable()
export class OperatorsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(actor: AuthUser): Promise<OperatorSummary[]> {
    this.assertPlatformAdmin(actor, 'view operators')

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
      facilityCount: operator._count.facilities,
      memberCount: operator._count.memberships,
      createdAt: operator.createdAt,
    }))
  }

  async suspend(actor: AuthUser, id: string): Promise<void> {
    this.assertPlatformAdmin(actor, 'suspend operators')

    const { count } = await this.prisma.parkingOperator.updateMany({
      where: { id, status: OperatorStatus.VERIFIED },
      data: { status: OperatorStatus.SUSPENDED },
    })
    if (count === 0) await this.explainFailedTransition(id, OperatorStatus.VERIFIED)
  }

  async reactivate(actor: AuthUser, id: string): Promise<void> {
    this.assertPlatformAdmin(actor, 'reactivate operators')

    // verifiedAt is left untouched: it records the original verification, not this
    // restoration of access.
    const { count } = await this.prisma.parkingOperator.updateMany({
      where: { id, status: OperatorStatus.SUSPENDED },
      data: { status: OperatorStatus.VERIFIED },
    })
    if (count === 0) await this.explainFailedTransition(id, OperatorStatus.SUSPENDED)
  }

  private assertPlatformAdmin(actor: AuthUser, action: string): void {
    // Controller already gates on @Roles('platform_admin'); re-check in the service
    // layer per the both-layers authorization rule.
    if (actor.role !== 'platform_admin') {
      throw new ForbiddenException(`Only platform admins may ${action}`)
    }
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
