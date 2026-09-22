import { createHash } from 'crypto'
import type { ConfigService } from '@nestjs/config'
import { PasswordResetOrigin } from '@prisma/client'
import { InvalidCredentialsError } from '@spark/auth'
import type { AuthContext } from '@spark/auth'
import type { NotificationsService } from '../notifications/notifications.service'
import type { PrismaService } from '../prisma/prisma.service'
import { InvalidResetTokenError } from './auth.types'
import { PasswordResetService } from './password-reset.service'

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

const LOCAL_USER = { id: 'u-local', email: 'local@spark.gr', role: 'USER' as const }
const FIREBASE_USER = { id: 'u-fb', email: 'owner@spark.gr', role: 'OPERATOR_ADMIN' as const }

// What the controller hands requestChange: the caller resolved from the verified token,
// which speaks the contract role vocabulary rather than Prisma's.
const CALLER = { id: 'u-local', email: 'local@spark.gr', role: 'operator_admin' }

describe('PasswordResetService', () => {
  let prisma: {
    user: { findUnique: jest.Mock }
    passwordResetToken: { findUnique: jest.Mock; create: jest.Mock; updateMany: jest.Mock }
    auditLog: { create: jest.Mock }
    $transaction: jest.Mock
  }
  let notifications: { sendPasswordReset: jest.Mock; sendPasswordChange: jest.Mock }
  let config: { getOrThrow: jest.Mock }
  let auth: { resetPassword: jest.Mock; signIn: jest.Mock }
  let service: PasswordResetService

  beforeEach(() => {
    prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(null) },
      passwordResetToken: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockReturnValue({ __op: 'create' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      auditLog: { create: jest.fn().mockReturnValue({ __op: 'audit' }) },
      $transaction: jest.fn().mockResolvedValue([]),
    }
    notifications = {
      sendPasswordReset: jest.fn().mockResolvedValue(undefined),
      sendPasswordChange: jest.fn().mockResolvedValue(undefined),
    }
    config = { getOrThrow: jest.fn().mockReturnValue('http://localhost:3000') }
    auth = {
      resetPassword: jest.fn().mockResolvedValue(undefined),
      signIn: jest.fn().mockResolvedValue({ session: { accessToken: 'at' } }),
    }

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

  // The audit write is built as a Prisma operation and handed to $transaction, so what
  // proves it happened is the create call that produced it, not a resolved promise.
  const auditedData = (nth = 0): Record<string, unknown> =>
    prisma.auditLog.create.mock.calls[nth]![0].data

  describe('request', () => {
    it('issues a token and emails the link for an existing account', async () => {
      prisma.user.findUnique.mockResolvedValue(LOCAL_USER)

      await expect(service.request('Local@Spark.gr')).resolves.toBeUndefined()

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { email: 'local@spark.gr' },
        select: { id: true, email: true, role: true },
      })
      expect(prisma.$transaction).toHaveBeenCalledTimes(1)

      const rawToken = emailedToken()
      expect(rawToken).toMatch(/^[a-f0-9]{64}$/)
      expect(notifications.sendPasswordReset.mock.calls[0]![0].to).toBe('local@spark.gr')

      // Only the hash is persisted; the raw token exists solely in the emailed link.
      const created = prisma.passwordResetToken.create.mock.calls[0]![0].data
      expect(created.tokenHash).toBe(sha256(rawToken))
      expect(created.userId).toBe('u-local')
      expect(created.origin).toBe(PasswordResetOrigin.FORGOT_PASSWORD)
      expect(JSON.stringify(created)).not.toContain(rawToken)
    })

    it('records the request as the forgot-password flow, attributed to the account itself', async () => {
      prisma.user.findUnique.mockResolvedValue(LOCAL_USER)

      await service.request('local@spark.gr')

      expect(auditedData()).toMatchObject({
        actorId: 'u-local',
        // Normalised out of the Prisma enum: every other audit writer takes the role off a
        // verified token, and one log must not file 'USER' beside 'user' for one person.
        actorRole: 'user',
        action: 'password.reset_requested',
        entityType: 'User',
        entityId: 'u-local',
        payload: { origin: PasswordResetOrigin.FORGOT_PASSWORD },
      })
    })

    // The audit row would name an address that has no account — a record of what an
    // unauthenticated caller guessed at — and the write is measurable work in the one
    // branch the uniform response exists to flatten.
    it('gives an unknown address the same undefined result, with no token, email or audit row', async () => {
      prisma.user.findUnique.mockResolvedValue(null)

      await expect(service.request('ghost@spark.gr')).resolves.toBeUndefined()

      expect(prisma.$transaction).not.toHaveBeenCalled()
      expect(prisma.passwordResetToken.create).not.toHaveBeenCalled()
      expect(notifications.sendPasswordReset).not.toHaveBeenCalled()
      expect(prisma.auditLog.create).not.toHaveBeenCalled()
    })

    it('never writes the raw token or a credential into the audit payload', async () => {
      prisma.user.findUnique.mockResolvedValue(LOCAL_USER)

      await service.request('local@spark.gr')

      expect(JSON.stringify(auditedData())).not.toContain(emailedToken())
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
      // Same transaction as the create, so there is never a window with two live grants —
      // and as the audit row, so a grant can never exist unrecorded.
      const [ops] = prisma.$transaction.mock.calls[0]!
      expect(ops).toHaveLength(3)
    })
  })

  describe('requestChange', () => {
    const changeLink = (): string => notifications.sendPasswordChange.mock.calls[0]![0].resetLink

    it('proves the current password before minting anything', async () => {
      await service.requestChange(CALLER, 'current-pw')

      expect(auth.signIn).toHaveBeenCalledWith({
        email: 'local@spark.gr',
        password: 'current-pw',
      })
      expect(auth.signIn.mock.invocationCallOrder[0]!).toBeLessThan(
        prisma.passwordResetToken.create.mock.invocationCallOrder[0]!,
      )
    })

    // The knowledge factor is a gate, not a note: a wrong password must leave nothing
    // behind — no grant an attacker could race for, and no mail to the real owner's inbox.
    it('propagates a wrong current password and mints no grant, mail or audit row', async () => {
      auth.signIn.mockRejectedValue(new InvalidCredentialsError())

      await expect(service.requestChange(CALLER, 'wrong-pw')).rejects.toBeInstanceOf(
        InvalidCredentialsError,
      )

      expect(prisma.$transaction).not.toHaveBeenCalled()
      expect(prisma.passwordResetToken.create).not.toHaveBeenCalled()
      expect(notifications.sendPasswordChange).not.toHaveBeenCalled()
      expect(prisma.auditLog.create).not.toHaveBeenCalled()
    })

    it('mints a CHANGE_PASSWORD grant and invalidates outstanding ones in the same transaction', async () => {
      await service.requestChange(CALLER, 'current-pw')

      expect(prisma.passwordResetToken.updateMany).toHaveBeenCalledWith({
        where: { userId: 'u-local', usedAt: null },
        data: { usedAt: expect.any(Date) },
      })

      const created = prisma.passwordResetToken.create.mock.calls[0]![0].data
      expect(created.origin).toBe(PasswordResetOrigin.CHANGE_PASSWORD)
      expect(created.userId).toBe('u-local')
      expect(created.tokenHash).toBe(sha256(changeLink().split('/reset-password/')[1]!))
      expect(JSON.stringify(created)).not.toContain(changeLink().split('/reset-password/')[1]!)

      const [ops] = prisma.$transaction.mock.calls[0]!
      expect(ops).toHaveLength(3)
    })

    // Same consume page as the logged-out flow: the grant is the same kind of grant, and
    // duplicating the page would duplicate the single-use races that guard it.
    it('emails a link to the shared reset page, awaited rather than raced past', async () => {
      await service.requestChange(CALLER, 'current-pw')

      expect(notifications.sendPasswordChange).toHaveBeenCalledTimes(1)
      expect(notifications.sendPasswordReset).not.toHaveBeenCalled()
      expect(notifications.sendPasswordChange.mock.calls[0]![0].to).toBe('local@spark.gr')
      expect(changeLink()).toMatch(/^http:\/\/localhost:3000\/reset-password\/[a-f0-9]{64}$/)
      expect(notifications.sendPasswordChange.mock.results[0]!.value).toBeInstanceOf(Promise)
    })

    it('records the request as the change-password flow, with the caller-supplied role', async () => {
      await service.requestChange(CALLER, 'current-pw')

      expect(auditedData()).toMatchObject({
        actorId: 'u-local',
        actorRole: 'operator_admin',
        action: 'password.change_requested',
        entityType: 'User',
        entityId: 'u-local',
        payload: {
          origin: PasswordResetOrigin.CHANGE_PASSWORD,
          currentPasswordVerified: true,
        },
      })
    })

    it('keeps the current password and the raw token out of the audit payload', async () => {
      await service.requestChange(CALLER, 'current-pw')

      const serialised = JSON.stringify(auditedData())
      expect(serialised).not.toContain('current-pw')
      expect(serialised).not.toContain(changeLink().split('/reset-password/')[1]!)
    })

    // The padding in request() defends an unauthenticated caller's enumeration probe.
    // This caller is authenticated and asking about the account they are signed in to, so
    // there is nothing to flatten and no reason to hold the response for a quarter second.
    it('does not pay the uniform-response floor the logged-out flow pays', async () => {
      const startedAt = Date.now()
      await service.requestChange(CALLER, 'current-pw')

      expect(Date.now() - startedAt).toBeLessThan(200)
    })
  })

  describe('reset', () => {
    const grant = (overrides: Record<string, unknown> = {}) => ({
      id: 'prt-1',
      userId: LOCAL_USER.id,
      origin: PasswordResetOrigin.FORGOT_PASSWORD,
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
      user: { email: LOCAL_USER.email, role: LOCAL_USER.role },
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
        grant({
          userId: FIREBASE_USER.id,
          user: { email: FIREBASE_USER.email, role: FIREBASE_USER.role },
        }),
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

    // One consume endpoint, two histories. Without this the knowledge-of-current-password
    // factor the change flow enforces leaves no trace anyone can read back.
    it('files a forgot-password grant as a completed reset', async () => {
      prisma.passwordResetToken.findUnique.mockResolvedValue(grant())

      await service.reset('raw-token', 'brand-new-pw')

      expect(auditedData()).toMatchObject({
        actorId: 'u-local',
        actorRole: 'user',
        action: 'password.reset_completed',
        entityType: 'User',
        entityId: 'u-local',
        payload: { origin: PasswordResetOrigin.FORGOT_PASSWORD, grantId: 'prt-1' },
      })
    })

    it('files a change-password grant as a completed change', async () => {
      prisma.passwordResetToken.findUnique.mockResolvedValue(
        grant({ origin: PasswordResetOrigin.CHANGE_PASSWORD }),
      )

      await service.reset('raw-token', 'brand-new-pw')

      expect(auditedData()).toMatchObject({
        action: 'password.changed',
        payload: { origin: PasswordResetOrigin.CHANGE_PASSWORD, grantId: 'prt-1' },
      })
    })

    it('records nothing when the token is refused', async () => {
      prisma.passwordResetToken.findUnique.mockResolvedValue(grant({ usedAt: new Date() }))

      await service.reset('raw-token', 'brand-new-pw').catch(() => undefined)

      expect(prisma.auditLog.create).not.toHaveBeenCalled()
    })

    it('keeps the new password and the raw token out of the audit payload', async () => {
      prisma.passwordResetToken.findUnique.mockResolvedValue(grant())

      await service.reset('raw-token', 'brand-new-pw')

      const serialised = JSON.stringify(auditedData())
      expect(serialised).not.toContain('brand-new-pw')
      expect(serialised).not.toContain('raw-token')
      expect(serialised).not.toContain(sha256('raw-token'))
    })
  })
})
