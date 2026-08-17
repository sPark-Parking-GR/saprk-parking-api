import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common'
import { ApplicationConfig } from '@nestjs/core'
import { isPlatformRole } from '@spark/types'
import type { AuthenticatedRequest } from '../../common/types/request'

const ADMIN_SEGMENT = '/admin'

/**
 * Backstop for the `/admin/*` surface. RolesGuard and PermissionGuard are opt-in: a route
 * carrying neither decorator is admitted to anyone AuthGuard let through, so a new admin
 * controller that forgets @RequirePermission silently ships an operator-reachable endpoint.
 * Keying off the URL instead of metadata makes the check impossible to forget — the prefix
 * IS the declaration — and it stays a floor rather than a ceiling: non-admin paths return
 * true untouched, and admin paths still have to satisfy whatever decorators they do carry.
 */
@Injectable()
export class AdminRouteGuard implements CanActivate {
  constructor(private readonly appConfig: ApplicationConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>()

    if (!this.isAdminRoute(request.url)) return true

    // Admits the whole administrative tier, not one role: this is a floor that keeps
    // undecorated admin routes off the operator surface, NOT the place that distinguishes
    // platform_admin from super_admin. That distinction is per-route, and lives in the
    // @RequirePermission decorators and the services behind them.
    if (!request.user || !isPlatformRole(request.user.role)) {
      throw new ForbiddenException('Insufficient permissions')
    }

    return true
  }

  private isAdminRoute(url: string): boolean {
    // Lower-cased because the guard must not be able to disagree with the router about
    // which handler a URL reaches: if the adapter is ever configured case-insensitively,
    // `/Admin/operators` would still resolve to an admin controller.
    const path = (url.split('?')[0] ?? '').toLowerCase()
    const prefix = this.globalPrefix()
    const route = prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path

    return route === ADMIN_SEGMENT || route.startsWith(`${ADMIN_SEGMENT}/`)
  }

  // Read from ApplicationConfig rather than hardcoded, so the guard keeps matching if
  // main.ts's setGlobalPrefix() changes and so it works in tests that set no prefix.
  private globalPrefix(): string {
    const prefix = this.appConfig.getGlobalPrefix().replace(/^\/*/, '').replace(/\/*$/, '')
    return prefix ? `/${prefix.toLowerCase()}` : ''
  }
}
