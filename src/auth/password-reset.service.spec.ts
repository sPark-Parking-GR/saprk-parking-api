import { createHash } from 'crypto'
import type { ConfigService } from '@nestjs/config'
import type { AuthContext } from '@spark/auth'
import type { NotificationsService } from '../notifications/notifications.service'
import type { PrismaService } from '../prisma/prisma.service'
import { InvalidResetTokenError } from './auth.types'
import { PasswordResetService } from './password-reset.service'

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

const LOCAL_USER = { id: 'u-local', email: 'local@spark.gr' }
const FIREBASE_USER = { id: 'u-fb', email: 'owner@spark.gr' }

describe('PasswordResetService', () => {
  let prisma: {
    user: { findUnique: jest.Mock }
    passwordResetToken: { findUnique: jest.Mock; create: jest.Mock; updateMany: jest.Mock }
    $transaction: jest.Mock
  }
  let notifications: { sendPasswordReset: jest.Mock }
  let config: { getOrThrow: jest.Mock }
  let auth: { resetPassword: jest.Mock }
  let service: PasswordResetService

  beforeEach(() => {
    prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(null) },
      passwordResetToken: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockReturnValue({ __op: 'create' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn().mockResolvedValue([]),
    }
    notifications = { sendPasswordReset: jest.fn().mockResolvedValue(undefined) }
    config = { getOrThrow: jest.fn().mockReturnValue('http://localhost:3000') }
    auth = { resetPassword: jest.fn().mockResolvedValue(undefined) }

    service = new PasswordResetService(
      prisma as unknown as PrismaService,
      notifications as unknown as NotificationsService,
      config as unknown as ConfigService,
      auth as unknown as AuthContext,
    )
  })

  const emailedToken = (): string => {
    const link: string = notifications.sendPasswordReset.mock.calls[0]![0].resetLink
    return link.split('/reset-password/')[1]!
  }

  describe('request', () => {
    it('issues a token and emails the link for an existing account', async () => {
      prisma.user.findUnique.mockResolvedValue(LOCAL_USER)

      await expect(service.request('Local@Spark.gr')).resolves.toBeUndefined()

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { email: 'local@spark.gr' },
        select: { id: true, email: true },
      })
      expect(prisma.$transaction).toHaveBeenCalledTimes(1)

      const rawToken = emailedToken()
      expect(rawToken).toMatch(/^[a-f0-9]{64}$/)
      expect(notifications.sendPasswordReset.mock.calls[0]![0].to).toBe('local@spark.gr')

      // Only the hash is persisted; the raw token exists solely in the emailed link.
      const created = prisma.passwordResetToken.create.mock.calls[0]![0].data
      expect(created.tokenHash).toBe(sha256(rawToken))
      expect(created.userId).toBe('u-local')
      expect(JSON.stringify(created)).not.toContain(rawToken)
    })

    it('gives an unknown address the same undefined result, with no token and no email', async () => {
      prisma.user.findUnique.mockResolvedValue(null)

      await expect(service.request('ghost@spark.gr')).resolves.toBeUndefined()

      expect(prisma.$transaction).not.toHaveBeenCalled()
      expect(prisma.passwordResetToken.create).not.toHaveBeenCalled()
      expect(notifications.sendPasswordReset).not.toHaveBeenCalled()
    })

    // The endpoint answers 204 either way, so elapsed time is the only channel left; both
    // branches are padded to the same floor so the extra writes an account triggers do not
    // show up as a measurable difference.
    it('takes comparable time whether or not the account exists', async () => {
      prisma.user.findUnique.mockResolvedValue(LOCAL_USER)
      const startHit = Date.now()
      await service.request('local@spark.gr')
      const hit = Date.now() - startHit

      prisma.user.findUnique.mockResolvedValue(null)
      const startMiss = Date.now()
      await service.request('ghost@spark.gr')
      const miss = Date.now() - startMiss

      expect(Math.abs(hit - miss)).toBeLessThan(50)
    })

    it('invalidates outstanding tokens for the user before issuing a new one', async () => {
      prisma.user.findUnique.mockResolvedValue(LOCAL_USER)

      await service.request('local@spark.gr')

      expect(prisma.passwordResetToken.updateMany).toHaveBeenCalledWith({
        where: { userId: 'u-local', usedAt: null },
        data: { usedAt: expect.any(Date) },
      })
      // Same transaction as the create, so there is never a window with two live grants.
      const [ops] = prisma.$transaction.mock.calls[0]!
      expect(ops).toHaveLength(2)
    })
  })

  describe('reset', () => {
    const grant = (overrides: Record<string, unknown> = {}) => ({
      id: 'prt-1',
      userId: LOCAL_USER.id,
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
      user: { email: LOCAL_USER.email },
      ...overrides,
    })

    it('looks the grant up by hash and applies the password through the auth context', async () => {
      prisma.passwordResetToken.findUnique.mockResolvedValue(grant())

      await expect(service.reset('raw-token', 'brand-new-pw')).resolves.toBeUndefined()

      expect(prisma.passwordResetToken.findUnique.mock.calls[0]![0].where).toEqual({
        tokenHash: sha256('raw-token'),
      })
      expect(auth.resetPassword).toHaveBeenCalledWith({ email: 'local@spark.gr' }, 'brand-new-pw')
    })

    it('routes a Firebase-backed account through the same path', async () => {
      prisma.passwordResetToken.findUnique.mockResolvedValue(
        grant({ userId: FIREBASE_USER.id, user: { email: FIREBASE_USER.email } }),
      )

      await service.reset('raw-token', 'brand-new-pw')

      // The composite provider picks the backend by email; this service stays agnostic.
      expect(auth.resetPassword).toHaveBeenCalledWith({ email: 'owner@spark.gr' }, 'brand-new-pw')
    })

    it('burns the grant before touching the password, and every sibling grant with it', async () => {
      prisma.passwordResetToken.findUnique.mockResolvedValue(grant())

      await service.reset('raw-token', 'brand-new-pw')

      expect(prisma.passwordResetToken.updateMany).toHaveBeenNthCalledWith(1, {
        where: { id: 'prt-1', usedAt: null },
        data: { usedAt: expect.any(Date) },
      })
      expect(prisma.passwordResetToken.updateMany).toHaveBeenNthCalledWith(2, {
        where: { userId: 'u-local', usedAt: null },
        data: { usedAt: expect.any(Date) },
      })
    })

    it('refuses a token that was already used', async () => {
      prisma.passwordResetToken.findUnique.mockResolvedValue(grant({ usedAt: new Date() }))

      await expect(service.reset('raw-token', 'brand-new-pw')).rejects.toBeInstanceOf(
        InvalidResetTokenError,
      )
      expect(auth.resetPassword).not.toHaveBeenCalled()
    })

    it('refuses a second concurrent use that loses the conditional-update race', async () => {
      prisma.passwordResetToken.findUnique.mockResolvedValue(grant())
      prisma.passwordResetToken.updateMany.mockResolvedValue({ count: 0 })

      await expect(service.reset('raw-token', 'brand-new-pw')).rejects.toBeInstanceOf(
        InvalidResetTokenError,
      )
      expect(auth.resetPassword).not.toHaveBeenCalled()
    })

    it('refuses an expired token', async () => {
      prisma.passwordResetToken.findUnique.mockResolvedValue(
        grant({ expiresAt: new Date(Date.now() - 1) }),
      )

      await expect(service.reset('raw-token', 'brand-new-pw')).rejects.toBeInstanceOf(
        InvalidResetTokenError,
      )
      expect(auth.resetPassword).not.toHaveBeenCalled()
    })

    it('refuses an unknown token', async () => {
      prisma.passwordResetToken.findUnique.mockResolvedValue(null)

      await expect(service.reset('raw-token', 'brand-new-pw')).rejects.toBeInstanceOf(
        InvalidResetTokenError,
      )
    })

    // Unknown, expired and spent tokens must be indistinguishable, or the endpoint becomes
    // an oracle telling an attacker which guessed tokens were ever real.
    it('reports unknown, expired and spent tokens identically', async () => {
      const messages: string[] = []
      for (const state of [
        null,
        grant({ usedAt: new Date() }),
        grant({ expiresAt: new Date(0) }),
      ]) {
        prisma.passwordResetToken.findUnique.mockResolvedValue(state)
        await service.reset('raw-token', 'brand-new-pw').catch((err: Error) => {
          messages.push(err.message)
        })
      }
      expect(messages).toHaveLength(3)
      expect(new Set(messages).size).toBe(1)
    })
  })
})
