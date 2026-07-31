import { ForbiddenException, Injectable } from '@nestjs/common'
import { OperatorMemberRole } from '@prisma/client'
import type { AuthUser } from '@spark/types'
import { OperatorScopeService, targetOperatorId } from '../common/authz/operator-scope.service'
import { PrismaService } from '../prisma/prisma.service'
import { OperatorNotFoundError } from './operators.types'

/**
 * Answers "which operator may this caller administer?" for every write that touches an
 * operator's people — member role changes, removals, and the invites that create members.
 * Kept apart from OperatorsService, whose operations are platform-admin-only operator
 * lifecycle and share none of these rules.
 */
@Injectable()
export class OperatorAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operatorScope: OperatorScopeService,
  ) {}

  async resolveAdministrable(actor: AuthUser, requested: string | undefined): Promise<string> {
    const scope = await this.operatorScope.resolve(actor)

    // Checked BEFORE targetOperatorId, which exists for the create path where the id is an
    // optional hint: given a foreign id it answers a single-membership caller with THEIR
    // operator and silently drops the one they named. Harmless for a hint, a cross-tenant
    // write when the id addresses the resource. Answered as not-found rather than
    // forbidden so the endpoint does not confirm that another tenant's id is real.
    if (
      scope.kind === 'operator' &&
      requested !== undefined &&
      !scope.operatorIds.includes(requested)
    ) {
      throw new OperatorNotFoundError(requested)
    }

    // Reused for exactly the ambiguity it was written for: a platform caller must name a
    // target, a caller with one membership implies it, and a caller with several has no
    // implied tenant and is refused rather than landed in an arbitrary one.
    const operatorId = targetOperatorId(scope, requested)
    if (scope.kind === 'platform') return operatorId

    // Membership is not enough. UserRole.OPERATOR_ADMIN is global, so a user who admins one
    // operator and is only STAFF in another would otherwise administer both.
    const membership = await this.prisma.operatorMembership.findUnique({
      where: { operatorId_userId: { operatorId, userId: actor.id } },
      select: { role: true },
    })
    if (membership?.role !== OperatorMemberRole.ADMIN) {
      throw new ForbiddenException('Only an admin of this operator may manage its members')
    }

    return operatorId
  }

  /** Every operator the caller admins, or null for a platform caller (meaning: all). */
  async administrableOperatorIds(actor: AuthUser): Promise<string[] | null> {
    const scope = await this.operatorScope.resolve(actor)
    if (scope.kind === 'platform') return null

    const memberships = await this.prisma.operatorMembership.findMany({
      where: {
        userId: actor.id,
        operatorId: { in: scope.operatorIds },
        role: OperatorMemberRole.ADMIN,
      },
      select: { operatorId: true },
    })
    return memberships.map((m) => m.operatorId)
  }
}
