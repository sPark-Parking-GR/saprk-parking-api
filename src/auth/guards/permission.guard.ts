import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { hasPlatformPermission, type PlatformPermission } from '@spark/types'
import type { AuthenticatedRequest } from '../../common/types/request'
import { PERMISSIONS_KEY } from '../decorators/require-permission.decorator'

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<PlatformPermission[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ])

    // No decorator means this guard has no opinion: an undecorated route keeps whatever
    // AuthGuard and RolesGuard decided about it, exactly as before this guard existed.
    if (!required || required.length === 0) return true

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>()
    const user = request.user

    if (!user) throw new ForbiddenException('Authentication required for this resource')

    // Permissions are DERIVED from the role on every request rather than embedded in the
    // token. Embedding would freeze the grant into a 15-minute bearer credential: a role
    // change bumps sessionsValidFrom and so is caught by SessionRevocationService, but an
    // edit to ROLE_PLATFORM_PERMISSIONS itself moves no watermark, and every live token
    // would keep the old capability set until it expired. Deriving costs one in-memory
    // lookup and makes a map edit effective platform-wide on the next request.
    if (!required.every((permission) => hasPlatformPermission(user.role, permission))) {
      throw new ForbiddenException('Insufficient permissions')
    }

    return true
  }
}
