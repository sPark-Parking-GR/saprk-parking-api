import { Injectable } from '@nestjs/common'
import type { AuthUser } from '@spark/types'
import { PrismaService } from '../../prisma/prisma.service'
import {
  DomainError,
  OperatorContextRequiredError,
  OperatorTargetRequiredError,
} from '../errors/domain.errors'

export type OperatorScope = { kind: 'platform' } | { kind: 'operator'; operatorIds: string[] }

export type OperatorScopeWhere = { operatorId?: { in: string[] } }

/**
 * The single operator a create lands in. A platform admin must always name one. An
 * operator caller with exactly one membership implies it (a stray body operatorId stays
 * ignored, as the DTOs document), but with several memberships there is no implied
 * tenant — the caller must name one they belong to, or the create is refused rather
 * than silently landing in an arbitrary operator.
 */
export function targetOperatorId(scope: OperatorScope, requested: string | undefined): string {
  if (scope.kind === 'platform') {
    if (!requested) throw new DomainError('operatorId required')
    return requested
  }

  if (requested !== undefined && scope.operatorIds.includes(requested)) return requested
  if (scope.operatorIds.length === 1) return scope.operatorIds[0]!

  throw new OperatorTargetRequiredError()
}

@Injectable()
export class OperatorScopeService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(user: AuthUser): Promise<OperatorScope> {
    if (user.role === 'platform_admin') return { kind: 'platform' }

    if (user.role === 'operator_admin' || user.role === 'operator_staff') {
      // A user may belong to several operators; every one of them is in scope, so a
      // multi-operator caller can never be narrowed to an arbitrary single tenant.
      const memberships = await this.prisma.operatorMembership.findMany({
        where: { userId: user.id },
        select: { operatorId: true },
      })
      if (memberships.length === 0) throw new OperatorContextRequiredError()
      return { kind: 'operator', operatorIds: memberships.map((m) => m.operatorId) }
    }

    throw new OperatorContextRequiredError()
  }

  scopeWhere(scope: OperatorScope): OperatorScopeWhere {
    return scope.kind === 'platform' ? {} : { operatorId: { in: scope.operatorIds } }
  }
}
