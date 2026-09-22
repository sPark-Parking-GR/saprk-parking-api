import {
  Controller,
  Get,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import type { UserRole } from '@spark/types'
import type { AuthenticatedRequest } from '../../common/types/request'
import { RequirePermission } from '../decorators/require-permission.decorator'
import { Roles } from '../decorators/roles.decorator'
import { AdminRouteGuard } from './admin-route.guard'
import { PermissionGuard } from './permission.guard'
import { RolesGuard } from './roles.guard'

// Stands in for AuthGuard, whose own behaviour is covered by auth.guard.spec.ts. What is
// under test here is what the two authorization guards do downstream of it, so this only
// has to populate request.user the way AuthGuard does.
@Injectable()
class StubAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>()
    const header = request.headers['x-test-role']

    if (typeof header === 'string') {
      request.user = { id: 'u1', email: 'a@b.gr', role: header as UserRole, emailVerified: true }
    }
    return true
  }
}

@Controller('compose')
class ComposeController {
  @Get('undecorated')
  undecorated() {
    return { ok: true }
  }

  @Roles('operator_admin', 'platform_admin')
  @Get('roles-only')
  rolesOnly() {
    return { ok: true }
  }

  @RequirePermission('platform:tenant.read')
  @Get('permission-only')
  permissionOnly() {
    return { ok: true }
  }

  @Roles('operator_admin', 'platform_admin')
  @RequirePermission('platform:tenant.read')
  @Get('both')
  both() {
    return { ok: true }
  }
}

// Deliberately carries no @Roles and no @RequirePermission: it stands in for the admin
// controller someone adds next year and forgets to decorate.
@Controller('admin/compose')
class AdminComposeController {
  @Get('undecorated')
  undecorated() {
    return { ok: true }
  }
}

describe('RolesGuard and PermissionGuard composition', () => {
  let app: NestFastifyApplication

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ComposeController, AdminComposeController],
      providers: [
        { provide: APP_GUARD, useClass: StubAuthGuard },
        { provide: APP_GUARD, useClass: AdminRouteGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: APP_GUARD, useClass: PermissionGuard },
      ],
    }).compile()

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    app.useLogger(false)
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
  })

  afterAll(async () => {
    await app.close()
  })

  function inject(url: string, role?: UserRole): Promise<{ statusCode: number }> {
    return app.inject({
      method: 'GET',
      url,
      headers: role ? { 'x-test-role': role } : {},
    })
  }

  function get(path: string, role?: UserRole): Promise<{ statusCode: number }> {
    return inject(`/compose/${path}`, role)
  }

  describe('a route with no decorators', () => {
    it.each<UserRole | undefined>(['user', 'operator_admin', 'platform_admin', undefined])(
      'stays reachable by %s',
      async (role) => {
        expect((await get('undecorated', role)).statusCode).toBe(200)
      },
    )
  })

  describe('a route with @Roles only', () => {
    it('is unaffected by the permission guard', async () => {
      expect((await get('roles-only', 'operator_admin')).statusCode).toBe(200)
      expect((await get('roles-only', 'platform_admin')).statusCode).toBe(200)
      expect((await get('roles-only', 'user')).statusCode).toBe(403)
    })
  })

  describe('a route with @RequirePermission only', () => {
    it('admits a holder and refuses everyone else', async () => {
      expect((await get('permission-only', 'platform_admin')).statusCode).toBe(200)
      expect((await get('permission-only', 'operator_admin')).statusCode).toBe(403)
      expect((await get('permission-only', 'user')).statusCode).toBe(403)
    })
  })

  describe('a route with both decorators', () => {
    it('admits only a caller satisfying both', async () => {
      expect((await get('both', 'platform_admin')).statusCode).toBe(200)
    })

    it('refuses a caller holding the role but not the permission', async () => {
      expect((await get('both', 'operator_admin')).statusCode).toBe(403)
    })

    it('refuses a caller holding neither', async () => {
      expect((await get('both', 'user')).statusCode).toBe(403)
      expect((await get('both')).statusCode).toBe(403)
    })
  })

  describe('an /admin route with no decorators', () => {
    const url = '/admin/compose/undecorated'

    it('refuses an authenticated non-platform-admin', async () => {
      expect((await inject(url, 'operator_admin')).statusCode).toBe(403)
      expect((await inject(url, 'operator_staff')).statusCode).toBe(403)
      expect((await inject(url, 'user')).statusCode).toBe(403)
    })

    it('refuses a caller AuthGuard left anonymous', async () => {
      expect((await inject(url)).statusCode).toBe(403)
    })

    it('admits a platform admin', async () => {
      expect((await inject(url, 'platform_admin')).statusCode).toBe(200)
    })

    it('is matched on the path, not on route metadata, query string included', async () => {
      expect((await inject(`${url}?take=10`, 'operator_admin')).statusCode).toBe(403)
      expect((await inject(`${url}?take=10`, 'platform_admin')).statusCode).toBe(200)
    })
  })
})
