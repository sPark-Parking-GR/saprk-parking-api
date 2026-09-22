import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { OperatorMemberRole } from '@prisma/client'
import { isPlatformRole, scopesFor, type OrgPermission } from '@spark/types'
import { ORG_PERMISSIONS_KEY } from '../decorators/require-org-permission.decorator'
import { PrismaService } from '../../prisma/prisma.service'
import type { AuthenticatedRequest } from '../../common/types/request'

/**
 * The org-scope floor.
 *
 * DELIBERATELY COARSE, and the reason is structural: most operator-scoped routes do not
 * name their operator: OperatorScopeService derives it from the caller's memberships, which
 * has not happened yet when a guard runs. So this answers only "may this person do this KIND
 * of thing at all", by asking whether ANY of their memberships grants the scope.
 *
 * WHICH operator they may do it to is a separate question, and one the codebase already
 * answers everywhere through OperatorScopeService's tenancy predicates. For a member of a
 * single operator — nearly everyone — the two coincide exactly. For someone who belongs to
 * two operators with different duties, this guard admits the request and
 * OperatorAccessService.assertScope, called by the service once it knows the operator, is
 * what refuses it. Same floor-plus-real-gate split AdminRouteGuard already uses.
 *
 * A route with no decorator is untouched, so adding the guard globally changes nothing until
 * a route opts in.
 */
@Injectable()
export class OrgPermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<OrgPermission[] | undefined>(
      ORG_PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    )
    if (!required || required.length === 0) return true

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>()
    const user = request.user
    if (!user) throw new ForbiddenException('Insufficient permissions')

    // Platform-tier callers are not scoped to an operator at all, so org scopes do not
    // apply to them — the same reason OperatorScopeService returns them a platform scope.
    if (isPlatformRole(user.role)) return true

    const memberships = await this.prisma.operatorMembership.findMany({
      where: { userId: user.id },
      select: { role: true, scopes: true },
    })

    const granted = new Set(
      memberships.flatMap((membership) =>
        scopesFor(membership.role === OperatorMemberRole.ADMIN ? 'ADMIN' : 'STAFF', membership.scopes),
      ),
    )

    if (!required.every((permission) => granted.has(permission))) {
      throw new ForbiddenException('Insufficient permissions for this operator')
    }
    return true
  }
}
