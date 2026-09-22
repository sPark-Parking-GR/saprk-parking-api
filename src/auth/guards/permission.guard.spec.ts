import { ForbiddenException, type ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { AuthUser, PlatformPermission, UserRole } from '@spark/types'
import { PermissionGuard } from './permission.guard'

function makeContext(user?: AuthUser): ExecutionContext {
  return {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext
}

const user = (role: UserRole): AuthUser => ({
  id: 'u1',
  email: 'a@b.gr',
  role,
  emailVerified: true,
})

describe('PermissionGuard', () => {
  let reflector: Reflector
  let guard: PermissionGuard

  beforeEach(() => {
    reflector = new Reflector()
    guard = new PermissionGuard(reflector)
  })

  function require(...permissions: PlatformPermission[]): void {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(permissions)
  }

  it('allows an undecorated route through untouched', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined)

    expect(guard.canActivate(makeContext(user('user')))).toBe(true)
    expect(guard.canActivate(makeContext(undefined))).toBe(true)
  })

  it('allows a route whose decorator lists no permission', () => {
    require()

    expect(guard.canActivate(makeContext(user('user')))).toBe(true)
  })

  it('allows a holder of the required permission', () => {
    require('platform:tenant.read')

    expect(guard.canActivate(makeContext(user('platform_admin')))).toBe(true)
  })

  it.each<UserRole>(['guest', 'user', 'operator_staff', 'operator_admin'])(
    'forbids %s, which does not hold the permission',
    (role) => {
      require('platform:tenant.read')

      expect(() => guard.canActivate(makeContext(user(role)))).toThrow(ForbiddenException)
    },
  )

  it('forbids when there is no authenticated user', () => {
    require('platform:tenant.read')

    expect(() => guard.canActivate(makeContext(undefined))).toThrow(ForbiddenException)
  })

  it('requires every listed permission, not any one of them', () => {
    require('platform:tenant.read', 'platform:tenant.purge')

    expect(guard.canActivate(makeContext(user('platform_admin')))).toBe(true)

    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue(['platform:tenant.read', 'not:a:permission' as PlatformPermission])

    expect(() => guard.canActivate(makeContext(user('platform_admin')))).toThrow(ForbiddenException)
  })
})
