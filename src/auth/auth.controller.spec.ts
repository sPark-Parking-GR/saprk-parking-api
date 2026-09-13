import { HTTP_CODE_METADATA } from '@nestjs/common/constants'
// Deep import: @nestjs/throttler does not re-export its metadata keys from the package root,
// and hard-coding the strings would let a rename pass silently.
import { THROTTLER_LIMIT, THROTTLER_TTL } from '@nestjs/throttler/dist/throttler.constants'
import { UnauthorizedException } from '@nestjs/common'
import type { AccountDeletionService } from './account-deletion.service'
import { AuthController } from './auth.controller'
import type { AuthService } from './auth.service'
import { InvalidResetTokenError } from './auth.types'
import { deleteAccountSchema, forgotPasswordSchema, resetPasswordSchema } from './dto/auth.dto'
import type { PasswordResetService } from './password-reset.service'
import { IS_PUBLIC_KEY } from './decorators/public.decorator'
import { ROLES_KEY } from './decorators/roles.decorator'

type Handler = 'forgotPassword' | 'resetPassword'

const handler = (name: Handler) => AuthController.prototype[name]

describe('AuthController password reset endpoints', () => {
  let passwordReset: { request: jest.Mock; reset: jest.Mock }
  let controller: AuthController

  beforeEach(() => {
    passwordReset = {
      request: jest.fn().mockResolvedValue(undefined),
      reset: jest.fn().mockResolvedValue(undefined),
    }
    controller = new AuthController(
      {} as unknown as AuthService,
      passwordReset as unknown as PasswordResetService,
      {} as unknown as AccountDeletionService,
    )
  })

  it.each<Handler>(['forgotPassword', 'resetPassword'])(
    '%s is public — a locked-out user has no token to authenticate with',
    (name) => {
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler(name))).toBe(true)
    },
  )

  it.each<Handler>(['forgotPassword', 'resetPassword'])('%s answers 204 with no body', (name) => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler(name))).toBe(204)
  })

  // Tighter than sign-up's 5/min: this endpoint sends mail to an address the caller does
  // not control, so it is both an enumeration probe and a spam amplifier.
  it('throttles forgot-password harder than sign-up', () => {
    expect(Reflect.getMetadata(THROTTLER_LIMIT + 'default', handler('forgotPassword'))).toBe(3)
    expect(Reflect.getMetadata(THROTTLER_TTL + 'default', handler('forgotPassword'))).toBe(60_000)
  })

  it('throttles reset-password so a token cannot be brute-forced', () => {
    expect(Reflect.getMetadata(THROTTLER_LIMIT + 'default', handler('resetPassword'))).toBe(5)
    expect(Reflect.getMetadata(THROTTLER_TTL + 'default', handler('resetPassword'))).toBe(60_000)
  })

  it('resolves with nothing for a known and an unknown address alike', async () => {
    await expect(controller.forgotPassword({ email: 'real@spark.gr' })).resolves.toBeUndefined()
    await expect(controller.forgotPassword({ email: 'ghost@spark.gr' })).resolves.toBeUndefined()
    expect(passwordReset.request).toHaveBeenCalledTimes(2)
  })

  it('never hands a reset token back to the caller', async () => {
    await expect(
      controller.resetPassword({ token: 'raw-token', password: 'brand-new-pw' }),
    ).resolves.toBeUndefined()
    expect(passwordReset.reset).toHaveBeenCalledWith('raw-token', 'brand-new-pw')
  })

  it('propagates a rejected token instead of reporting success', async () => {
    passwordReset.reset.mockRejectedValue(new InvalidResetTokenError())
    await expect(
      controller.resetPassword({ token: 'raw-token', password: 'brand-new-pw' }),
    ).rejects.toBeInstanceOf(InvalidResetTokenError)
  })

  describe('input validation', () => {
    it('rejects a malformed email', () => {
      expect(forgotPasswordSchema.safeParse({ email: 'not-an-email' }).success).toBe(false)
    })

    // Same floor as sign-up and invite-accept: a reset must not be a way to downgrade a
    // password below what registration would have accepted.
    it.each(['short', ''])('rejects the too-short password %p', (password) => {
      expect(resetPasswordSchema.safeParse({ token: 't', password }).success).toBe(false)
    })

    it('rejects a password over the 128-character maximum', () => {
      expect(resetPasswordSchema.safeParse({ token: 't', password: 'a'.repeat(129) }).success).toBe(
        false,
      )
    })

    it('rejects a missing token', () => {
      expect(resetPasswordSchema.safeParse({ token: '', password: 'brand-new-pw' }).success).toBe(
        false,
      )
    })
  })
})

describe('AuthController delete-account endpoint', () => {
  const handler = AuthController.prototype.deleteAccount

  let accountDeletion: { deleteOwnAccount: jest.Mock }
  let controller: AuthController

  const user = {
    id: 'u1',
    email: 'driver@spark.gr',
    role: 'user' as const,
    emailVerified: true,
  }

  beforeEach(() => {
    accountDeletion = { deleteOwnAccount: jest.fn().mockResolvedValue(undefined) }
    controller = new AuthController(
      {} as unknown as AuthService,
      {} as unknown as PasswordResetService,
      accountDeletion as unknown as AccountDeletionService,
    )
  })

  // The one endpoint here that must NOT be public: the account deleted is whoever the
  // guard resolved, and nothing in the request names a user.
  it('is not public', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBeUndefined()
  })

  // Every role may call this: the service branches on role, tombstoning a consumer's
  // whole account but only clearing mobile-side data for an operator or admin who also
  // uses the app as a driver.
  it('carries no role restriction', () => {
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toBeUndefined()
  })

  it('answers 204 with no body', () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(204)
  })

  // A wrong password here is an authentication attempt, throttled like forgot-password.
  it('throttles as hard as the other credential endpoints', () => {
    expect(Reflect.getMetadata(THROTTLER_LIMIT + 'default', handler)).toBe(3)
    expect(Reflect.getMetadata(THROTTLER_TTL + 'default', handler)).toBe(60_000)
  })

  it('passes the caller, the password and the bearer token to the service', async () => {
    await controller.deleteAccount(user, 'Bearer abc123', { password: 'correct-horse' })

    expect(accountDeletion.deleteOwnAccount).toHaveBeenCalledWith(user, 'correct-horse', 'abc123')
  })

  it('rejects a request with no bearer token', async () => {
    await expect(
      controller.deleteAccount(user, undefined, { password: 'correct-horse' }),
    ).rejects.toBeInstanceOf(UnauthorizedException)
    expect(accountDeletion.deleteOwnAccount).not.toHaveBeenCalled()
  })

  // Deliberately looser than signUpSchema: an account hashed under an older password
  // policy must still be able to confirm with the password it actually has.
  it('accepts any non-empty password and rejects an empty one', () => {
    expect(deleteAccountSchema.safeParse({ password: 'x' }).success).toBe(true)
    expect(deleteAccountSchema.safeParse({ password: '' }).success).toBe(false)
    expect(deleteAccountSchema.safeParse({}).success).toBe(false)
  })
})
