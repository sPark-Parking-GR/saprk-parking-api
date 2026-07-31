import { createHash, randomBytes } from 'crypto'
import { Inject, Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { AuthContext } from '@spark/auth'
import { NotificationsService } from '../notifications/notifications.service'
import { PrismaService } from '../prisma/prisma.service'
import { AUTH_CONTEXT_TOKEN } from './auth.constants'
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

  async request(email: string): Promise<void> {
    const startedAt = Date.now()
    try {
      const user = await this.prisma.user.findUnique({
        where: { email: email.toLowerCase() },
        select: { id: true, email: true },
      })
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
            expiresAt: new Date(Date.now() + RESET_TTL_MS),
          },
        }),
      ])

      // Raw token leaves the system only through the email channel — never in a response.
      // Dispatch is deliberately not awaited: an upstream ESP round-trip takes far longer
      // than anything the unknown-address branch does, which would hand an attacker the
      // enumeration signal the uniform 204 exists to deny. safeSend never rejects.
      void this.notifications.sendPasswordReset({
        to: user.email,
        resetLink: `${this.config.getOrThrow<string>('WEB_APP_URL')}/reset-password/${rawToken}`,
      })
    } finally {
      await sleep(UNIFORM_RESPONSE_MS - (Date.now() - startedAt))
    }
  }

  async reset(rawToken: string, newPassword: string): Promise<void> {
    const grant = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: this.hashToken(rawToken) },
      select: {
        id: true,
        userId: true,
        expiresAt: true,
        usedAt: true,
        user: { select: { email: true } },
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
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex')
  }
}
