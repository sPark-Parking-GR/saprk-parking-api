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

    const membership = await this.prisma.operatorMembership.findFirst({
      where: { userId: user.id },
      select: { operator: { select: { status: true } } },
    })

    if (membership?.operator.status === OperatorStatus.SUSPENDED) {
      throw new OperatorSuspendedError()
    }
  }
}
