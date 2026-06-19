import { UnauthorizedException, type ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { AuthUser } from '@spark/types'
import type { AuthService } from '../auth.service'
import { AuthGuard } from './auth.guard'

const validUser: AuthUser = { id: 'u1', email: 'a@b.gr', role: 'user', emailVerified: true }

function makeContext(headers: Record<string, string | undefined>): {
  ctx: ExecutionContext
  request: { headers: Record<string, string | undefined>; user?: AuthUser }
} {
  const request = { headers } as { headers: Record<string, string | undefined>; user?: AuthUser }
  const ctx = {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext
  return { ctx, request }
}

describe('AuthGuard', () => {
  let reflector: Reflector
  let authService: jest.Mocked<Pick<AuthService, 'verifyToken'>>
  let guard: AuthGuard

  beforeEach(() => {
    reflector = new Reflector()
    authService = { verifyToken: jest.fn() }
    guard = new AuthGuard(reflector, authService as unknown as AuthService)
  })

  it('rejects a protected route with no token', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false)
    const { ctx } = makeContext({})
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException)
  })

  it('allows a public route with no token', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true)
    const { ctx } = makeContext({})
    await expect(guard.canActivate(ctx)).resolves.toBe(true)
  })

  it('attaches the user and allows when the token is valid', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false)
    authService.verifyToken.mockResolvedValue({ user: validUser, isExpired: false })
    const { ctx, request } = makeContext({ authorization: 'Bearer good-token' })

    await expect(guard.canActivate(ctx)).resolves.toBe(true)
    expect(request.user).toEqual(validUser)
    expect(authService.verifyToken).toHaveBeenCalledWith('good-token')
  })

  it('rejects a protected route when the token is expired', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false)
    authService.verifyToken.mockResolvedValue({ user: validUser, isExpired: true })
    const { ctx } = makeContext({ authorization: 'Bearer stale' })

    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException)
  })
})
