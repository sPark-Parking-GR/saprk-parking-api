import { Injectable } from '@nestjs/common'
import type { AuthUser } from '@spark/types'
import { PrismaService } from '../../prisma/prisma.service'
import { OperatorContextRequiredError } from '../errors/domain.errors'

export type OperatorScope = { kind: 'platform' } | { kind: 'operator'; operatorId: string }

@Injectable()
export class OperatorScopeService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(user: AuthUser): Promise<OperatorScope> {
    if (user.role === 'platform_admin') return { kind: 'platform' }

    if (user.role === 'operator_admin' || user.role === 'operator_staff') {
      const membership = await this.prisma.operatorMembership.findFirst({
        where: { userId: user.id },
        select: { operatorId: true },
      })
      if (!membership) throw new OperatorContextRequiredError()
      return { kind: 'operator', operatorId: membership.operatorId }
    }

    throw new OperatorContextRequiredError()
  }

  scopeWhere(scope: OperatorScope): { operatorId?: string } {
    return scope.kind === 'platform' ? {} : { operatorId: scope.operatorId }
  }
}
