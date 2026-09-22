import { ForbiddenException, Injectable } from '@nestjs/common'
import { OperatorMemberRole } from '@prisma/client'
import {
  hasOrgPermission,
  isPlatformRole,
  scopesFor,
  type AuthUser,
  type OrgPermission,
} from '@spark/types'
import { OperatorScopeService, targetOperatorId } from '../common/authz/operator-scope.service'
import { PrismaService } from '../prisma/prisma.service'
import { OperatorNotFoundError } from './operators.types'

/** Phrased as the action refused, so the 403 says what was wanted rather than naming a scope. */
const DESCRIPTIONS: Record<OrgPermission, string> = {
  'org:facility.read': 'view this operator’s facilities',
  'org:facility.write': 'manage this operator’s facilities',
  'org:tariff.read': 'view this operator’s tariffs',
  'org:tariff.write': 'manage this operator’s tariffs',
  'org:booking.read': 'view this operator’s bookings',
  'org:booking.write': 'act on this operator’s bookings',
  'org:scan.execute': 'scan tickets for this operator',
  'org:stats.read': 'view this operator’s reporting',
  'org:member.manage': 'manage this operator’s team',
  'org:billing.view': 'view this operator’s plan and billing',
}

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

  /**
   * The authoritative org-scope check, as opposed to OrgPermissionGuard's floor.
   *
   * The guard can only ask whether SOME membership grants a scope, because most routes have
   * not resolved their operator by the time it runs. Once a service knows the operator — and
   * every service that touches one does — this answers the real question: does this caller
   * hold that scope IN THAT operator. For someone who is an administrator of one operator
   * and an attendant at another, this is the check that tells the two apart.
   */
  async assertScope(actor: AuthUser, operatorId: string, scope: OrgPermission): Promise<void> {
    // Platform-tier callers are unscoped by definition; org scopes describe membership, and
    // they hold none.
    if (isPlatformRole(actor.role)) return

    const membership = await this.prisma.operatorMembership.findUnique({
      where: { operatorId_userId: { operatorId, userId: actor.id } },
      select: { role: true, scopes: true },
    })
    // Not a member at all: reported as a missing operator rather than a refusal, matching
    // resolveAdministrable — the endpoint must not confirm that another tenant exists.
    if (!membership) throw new OperatorNotFoundError(operatorId)

    const granted = scopesFor(
      membership.role === OperatorMemberRole.ADMIN ? 'ADMIN' : 'STAFF',
      membership.scopes,
    )
    if (!hasOrgPermission(granted, scope)) {
      throw new ForbiddenException(`You do not have permission to ${DESCRIPTIONS[scope]}`)
    }
  }

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
