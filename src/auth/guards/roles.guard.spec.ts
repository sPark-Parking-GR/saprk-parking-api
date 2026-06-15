import { ForbiddenException, type ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { AuthUser, UserRole } from '@parqin/types'
import { RolesGuard } from './roles.guard'

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

describe('RolesGuard', () => {
  let reflector: Reflector
  let guard: RolesGuard

  beforeEach(() => {
    reflector = new Reflector()
    guard = new RolesGuard(reflector)
  })

  it('allows when no roles are required', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined)
    expect(guard.canActivate(makeContext(user('user')))).toBe(true)
  })

  it('allows when user role is in the required set', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['operator_admin'] as UserRole[])
    expect(guard.canActivate(makeContext(user('operator_admin')))).toBe(true)
  })

  it('forbids when user role is not in the required set', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['operator_admin'] as UserRole[])
    expect(() => guard.canActivate(makeContext(user('user')))).toThrow(ForbiddenException)
  })

  it('forbids when there is no authenticated user', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['user'] as UserRole[])
    expect(() => guard.canActivate(makeContext(undefined))).toThrow(ForbiddenException)
  })
})
