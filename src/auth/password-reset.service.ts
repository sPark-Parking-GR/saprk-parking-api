import { createHash, randomBytes } from 'crypto'
import { Inject, Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PasswordResetOrigin } from '@prisma/client'
import type { Prisma } from '@prisma/client'
import type { AuthContext } from '@spark/auth'
import { RequestContext } from '../common/context/request-context'
import { NotificationsService } from '../notifications/notifications.service'
import { PrismaService } from '../prisma/prisma.service'
import { AUTH_CONTEXT_TOKEN } from './auth.constants'
import { FROM_PRISMA } from './authjs-user.store'
import { InvalidResetTokenError } from './auth.types'

const RESET_TOKEN_BYTES = 32
const RESET_TTL_MS = 60 * 60 * 1000

// Both branches of the request endpoint are padded to this floor so the work an existing
// account triggers (two writes) cannot be distinguished from the no-op an unknown address
// takes. It is a floor, not a cap — see the dispatch comment in request().
const UNIFORM_RESPONSE_MS = 250

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

@Injectable()
export class PasswordResetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
    @Inject(AUTH_CONTEXT_TOKEN) private readonly auth: AuthContext,
  ) {}

  /**
   * The logged-out flow: somebody who cannot sign in asks for a link, and the only factor
   * they can offer is control of the mailbox.
   */
  async request(email: string): Promise<void> {
    const startedAt = Date.now()
    try {
      const user = await this.prisma.user.findUnique({
        where: { email: email.toLowerCase() },
        select: { id: true, email: true, role: true },
      })
      // No audit row on this branch, deliberately. There is no actor to attribute one to —
      // the address belongs to nobody — so it would be a log of who an unauthenticated
      // caller guessed at, and the write itself is measurable work in the one branch the
      // padding below exists to keep indistinguishable.
      if (!user) return

      const rawToken = randomBytes(RESET_TOKEN_BYTES).toString('hex')
      await this.prisma.$transaction([
        this.prisma.passwordResetToken.updateMany({
          where: { userId: user.id, usedAt: null },
          data: { usedAt: new Date() },
        }),
        this.prisma.passwordResetToken.create({
          data: {
            userId: user.id,
            tokenHash: this.hashToken(rawToken),
            // Explicit rather than left to the column default: this service now mints
            // grants for two flows, and which one a row came from is the only thing that
            // tells their completions apart afterwards.
            origin: PasswordResetOrigin.FORGOT_PASSWORD,
            expiresAt: new Date(Date.now() + RESET_TTL_MS),
          },
        }),
        // FROM_PRISMA because actorRole is read as one vocabulary: every other writer
        // takes the role off a verified token, so a role read straight out of the
        // database is normalised here rather than filing 'USER' beside 'user'.
        this.auditOp({ id: user.id, role: FROM_PRISMA[user.role] }, 'password.reset_requested', {
          origin: PasswordResetOrigin.FORGOT_PASSWORD,
        }),
      ])

      // Raw token leaves the system only through the email channel — never in a response.
      // Dispatch is deliberately not awaited: an upstream ESP round-trip takes far longer
      // than anything the unknown-address branch does, which would hand an attacker the
      // enumeration signal the uniform 204 exists to deny. safeSend never rejects.
      void this.notifications.sendPasswordReset({
        to: user.email,
        resetLink: this.resetLink(rawToken),
      })
    } finally {
      await sleep(UNIFORM_RESPONSE_MS - (Date.now() - startedAt))
    }
  }

  /**
   * The signed-in flow: a user who knows their current password asks to change it.
   *
   * Two factors, in order. The password proves the person rather than the session — a
   * bearer token says only that some device once signed in, and an unlocked laptop must
   * not be enough to rewrite the credential. The emailed link then proves they still hold
   * the mailbox, which is what stops a shoulder-surfed password from being enough on its
   * own. Only the second one actually writes the new password, through the same
   * `reset()` below, because the grant this mints is an ordinary PasswordResetToken.
   *
   * `user` comes from the verified token, so the account acted on is always the caller's
   * own and there is nothing in the request naming anyone else. An email that has since
   * been rewritten by a tombstone simply fails signIn — the safe direction.
   */
  async requestChange(
    user: { id: string; email: string; role: string },
    currentPassword: string,
  ): Promise<void> {
    // Routed through the auth context so it works against whichever backend holds the
    // credential. InvalidCredentialsError is left to propagate to a 401 rather than being
    // caught and reported as anything more specific, and nothing below runs until it
    // passes: a wrong password mints no grant, sends no mail and writes no audit row.
    await this.auth.signIn({ email: user.email, password: currentPassword })

    const rawToken = randomBytes(RESET_TOKEN_BYTES).toString('hex')
    await this.prisma.$transaction([
      this.prisma.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: new Date() },
      }),
      this.prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: this.hashToken(rawToken),
          origin: PasswordResetOrigin.CHANGE_PASSWORD,
          expiresAt: new Date(Date.now() + RESET_TTL_MS),
        },
      }),
      this.auditOp(user, 'password.change_requested', {
        origin: PasswordResetOrigin.CHANGE_PASSWORD,
        currentPasswordVerified: true,
      }),
    ])

    // Awaited, unlike request(). The uniform-timing defence there exists to stop an
    // unauthenticated caller learning which addresses have accounts; this caller is
    // already authenticated and asking about the one account they are signed in to, so
    // there is nothing to hide behind a fire-and-forget dispatch and no reason to answer
    // before the mail is actually on its way. safeSend still never rejects.
    await this.notifications.sendPasswordChange({
      to: user.email,
      resetLink: this.resetLink(rawToken),
    })
  }

  /**
   * The shared consume step. Both flows land here, because a grant is a grant — what
   * differs is what it took to earn one, and `origin` carries that through to the audit
   * log so a completed change is never filed as a completed reset.
   */
  async reset(rawToken: string, newPassword: string): Promise<void> {
    const grant = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: this.hashToken(rawToken) },
      select: {
        id: true,
        userId: true,
        origin: true,
        expiresAt: true,
        usedAt: true,
        user: { select: { email: true, role: true } },
      },
    })
    if (!grant || grant.usedAt || grant.expiresAt <= new Date()) throw new InvalidResetTokenError()

    // Conditional update on usedAt is the single-use guard: two requests replaying the same
    // token race here and exactly one of them updates a row. Consuming before applying the
    // password fails in the safe direction — a burnt token costs the user another email.
    const consumedAt = new Date()
    const { count } = await this.prisma.passwordResetToken.updateMany({
      where: { id: grant.id, usedAt: null },
      data: { usedAt: consumedAt },
    })
    if (count === 0) throw new InvalidResetTokenError()

    await this.prisma.passwordResetToken.updateMany({
      where: { userId: grant.userId, usedAt: null },
      data: { usedAt: consumedAt },
    })

    // Routes to whichever backend owns the credential and, in both, bumps
    // User.sessionsValidFrom so every session predating the reset stops verifying.
    await this.auth.resetPassword({ email: grant.user.email }, newPassword)

    // After the credential actually moved, and allowed to throw: a password that changed
    // with no record of it is worse than a request that reports a failure, and the caller
    // can always ask for another link.
    await this.auditOp(
      { id: grant.userId, role: FROM_PRISMA[grant.user.role] },
      grant.origin === PasswordResetOrigin.CHANGE_PASSWORD
        ? 'password.changed'
        : 'password.reset_completed',
      { origin: grant.origin, grantId: grant.id },
    )
  }

  private resetLink(rawToken: string): string {
    // One page for both flows. The link a change request sends is the same link a reset
    // request sends, because what it does on arrival is identical.
    return `${this.config.getOrThrow<string>('WEB_APP_URL')}/reset-password/${rawToken}`
  }

  /**
   * Builds the audit write rather than performing it, so the same helper serves a call
   * inside a `$transaction([...])` array — where the write has to be atomic with the grant
   * it describes — and a standalone `await` in `reset()`, where there is no transaction to
   * join because the credential itself moves outside the database.
   *
   * `payload` must never carry the raw token, the current password or the new one: nothing
   * here is a secret, and a reader of the audit log is not a reader of credentials. Actor
   * and subject are always the same person — every flow this service has is somebody
   * acting on their own credential, never an admin acting on someone else's.
   */
  private auditOp(
    actor: { id: string; role: string },
    action: string,
    payload: Prisma.InputJsonValue,
  ): Prisma.PrismaPromise<unknown> {
    return this.prisma.auditLog.create({
      data: {
        actorId: actor.id,
        actorRole: actor.role,
        action,
        entityType: 'User',
        entityId: actor.id,
        payload,
        ipAddress: RequestContext.getIp(),
      },
    })
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex')
  }
}
