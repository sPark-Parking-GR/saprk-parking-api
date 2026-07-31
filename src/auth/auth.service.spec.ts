import type { AuthContext } from '@spark/auth'
import type { AuthResult, AuthUser, UserRole } from '@spark/types'
import { OperatorStatusService } from '../common/authz/operator-status.service'
import { OperatorSuspendedError } from '../common/errors/domain.errors'
import type { PrismaService } from '../prisma/prisma.service'
import { AuthService } from './auth.service'
import { signUpSchema } from './dto/auth.dto'

function user(role: UserRole): AuthUser {
  return { id: `u-${role}`, email: `${role}@spark.gr`, role, emailVerified: true }
}

function authResult(role: UserRole): AuthResult {
  return {
    session: {
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: Date.now() + 60_000,
      user: user(role),
    },
  }
}

describe('AuthService', () => {
  let auth: { signIn: jest.Mock; refreshToken: jest.Mock; signUp: jest.Mock }
  let prisma: { operatorMembership: { findFirst: jest.Mock } }
  let service: AuthService

  const suspended = () =>
    prisma.operatorMembership.findFirst.mockResolvedValue({
      operator: { status: 'SUSPENDED' },
    })
  const active = () =>
    prisma.operatorMembership.findFirst.mockResolvedValue({
      operator: { status: 'VERIFIED' },
    })

  beforeEach(() => {
    auth = { signIn: jest.fn(), refreshToken: jest.fn(), signUp: jest.fn() }
    prisma = { operatorMembership: { findFirst: jest.fn().mockResolvedValue(null) } }
    service = new AuthService(
      auth as unknown as AuthContext,
      new OperatorStatusService(prisma as unknown as PrismaService),
    )
  })

  describe('signIn', () => {
    it('rejects a suspended operator instead of returning a usable session', async () => {
      auth.signIn.mockResolvedValue(authResult('operator_admin'))
      suspended()

      await expect(service.signIn({ email: 'a@b.gr', password: 'x' })).rejects.toBeInstanceOf(
        OperatorSuspendedError,
      )
    })

    it('returns the session for an active operator', async () => {
      const expected = authResult('operator_staff')
      auth.signIn.mockResolvedValue(expected)
      active()

      await expect(service.signIn({ email: 'a@b.gr', password: 'x' })).resolves.toBe(expected)
    })

    it.each<UserRole>(['user', 'platform_admin'])(
      'never blocks a %s, and does not query membership at all',
      async (role) => {
        const expected = authResult(role)
        auth.signIn.mockResolvedValue(expected)
        suspended()

        await expect(service.signIn({ email: 'a@b.gr', password: 'x' })).resolves.toBe(expected)
        expect(prisma.operatorMembership.findFirst).not.toHaveBeenCalled()
      },
    )
  })

  describe('refreshToken', () => {
    it('rejects a suspended operator so the body-token path cannot mint fresh tokens', async () => {
      auth.refreshToken.mockResolvedValue(authResult('operator_admin'))
      suspended()

      await expect(service.refreshToken('r')).rejects.toBeInstanceOf(OperatorSuspendedError)
    })

    it('returns the refreshed session for an active operator', async () => {
      const expected = authResult('operator_admin')
      auth.refreshToken.mockResolvedValue(expected)
      active()

      await expect(service.refreshToken('r')).resolves.toBe(expected)
    })

    it('never blocks a platform admin', async () => {
      const expected = authResult('platform_admin')
      auth.refreshToken.mockResolvedValue(expected)
      suspended()

      await expect(service.refreshToken('r')).resolves.toBe(expected)
      expect(prisma.operatorMembership.findFirst).not.toHaveBeenCalled()
    })
  })

  describe('signUp', () => {
    const body = { email: 'new@spark.gr', password: 'password123', displayName: 'New' }

    it('pins the role to user so public sign-up cannot mint privilege', async () => {
      auth.signUp.mockResolvedValue(authResult('user'))

      await service.signUp(body)

      expect(auth.signUp).toHaveBeenCalledWith({ ...body, role: 'user' })
    })

    it.each(['operator_admin', 'platform_admin', 'operator_staff'])(
      'still creates a plain user when the body carries role=%s',
      async (role) => {
        auth.signUp.mockResolvedValue(authResult('user'))

        // The DTO is the boundary the HTTP handler applies; an injected role must not
        // survive it, and must not survive the service either.
        const parsed = signUpSchema.parse({ ...body, role })
        expect(parsed).not.toHaveProperty('role')

        await service.signUp(parsed)

        expect(auth.signUp.mock.calls[0]![0].role).toBe('user')
      },
    )
  })

  it('treats an operator user with no membership row as active', async () => {
    const expected = authResult('operator_admin')
    auth.signIn.mockResolvedValue(expected)

    await expect(service.signIn({ email: 'a@b.gr', password: 'x' })).resolves.toBe(expected)
  })
})
