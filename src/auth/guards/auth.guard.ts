import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { OperatorStatusService } from '../../common/authz/operator-status.service'
import type { AuthenticatedRequest } from '../../common/types/request'
import { AuthService } from '../auth.service'
import { IS_PUBLIC_KEY } from '../decorators/public.decorator'
import { SessionRevocationService } from '../session-revocation.service'

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authService: AuthService,
    private readonly operatorStatus: OperatorStatusService,
    private readonly sessionRevocation: SessionRevocationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ])

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>()
    const token = this.extractToken(request)

    if (!token) {
      if (isPublic) return true
      throw new UnauthorizedException('Missing authentication token')
    }

    const result = await this.authService.verifyToken(token)

    // Deliberately a second query rather than something folded into OperatorStatusService:
    // that one reads OperatorMembership and only for operator roles, this one is a User
    // primary-key read every request pays. Merging them would force a join on every
    // request to save a query most requests never make, and would tie suspension policy
    // to session revocation. Short-circuits, so a bad or expired token costs nothing.
    if (
      !result ||
      result.isExpired ||
      (await this.sessionRevocation.isRevoked(result.user.id, result.issuedAt))
    ) {
      if (isPublic) return true
      throw new UnauthorizedException('Invalid or expired token')
    }

    request.user = result.user
    // Suspension takes effect on the very next request, not at the next login: an
    // already-issued, still-valid token must stop working the moment its operator is
    // suspended.
    await this.operatorStatus.assertOperatorActive(result.user)
    return true
  }

  private extractToken(request: AuthenticatedRequest): string | null {
    const header = request.headers['authorization']
    if (!header) return null
    const [scheme, value] = header.split(' ')
    if (scheme !== 'Bearer' || !value) return null
    return value
  }
}
