import { Injectable } from '@nestjs/common'
import { OperatorStatus } from '@prisma/client'
import type { AuthUser } from '@spark/types'
import { PrismaService } from '../../prisma/prisma.service'
import { OperatorSuspendedError } from '../errors/domain.errors'

@Injectable()
export class OperatorStatusService {
  constructor(private readonly prisma: PrismaService) {}

  async assertOperatorActive(user: AuthUser): Promise<void> {
    if (user.role !== 'operator_admin' && user.role !== 'operator_staff') return

    // Fail closed across EVERY membership: the suspension filter is pushed into the query
    // so a user who also belongs to an active operator cannot reach a suspended tenant.
    const suspended = await this.prisma.operatorMembership.findFirst({
      where: { userId: user.id, operator: { status: OperatorStatus.SUSPENDED } },
      select: { operator: { select: { status: true } } },
    })

    if (suspended?.operator.status === OperatorStatus.SUSPENDED) {
      throw new OperatorSuspendedError()
    }
  }
}
