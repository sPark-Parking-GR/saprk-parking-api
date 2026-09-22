import { Inject, Injectable } from '@nestjs/common'
import type { AuthContext } from '@spark/auth'
import type { AuthResult } from '@spark/types'
import { anyLifecycleStatus } from '../prisma/lifecycle.extension'
import { PrismaService } from '../prisma/prisma.service'
import { AUTH_CONTEXT_TOKEN } from './auth.constants'

export type EmailResolution =
  | { kind: 'free' }
  | { kind: 'linkable'; userId: string }
  | { kind: 'taken' }

/**
 * Resolves what an email address means for a flow that is about to grant a NEW
 * privileged role (operator self-registration, invite redemption) rather than create a
 * brand-new identity outright.
 *
 * A mobile-only account (role USER, no operator membership) has no reason to be
 * refused just because it already exists — the person redeeming an invite or
 * self-registering IS that account, proven by signing in with its password, not a
 * stranger colliding with it. Anything else already carrying a privileged role, or in
 * a non-ACTIVE lifecycle state, is genuinely taken and stays refused.
 */
@Injectable()
export class AccountLinkingService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(AUTH_CONTEXT_TOKEN) private readonly auth: AuthContext,
  ) {}

  async resolve(email: string): Promise<EmailResolution> {
    const existing = await this.prisma.user.findFirst({
      where: { email, lifecycleStatus: anyLifecycleStatus() },
      select: {
        id: true,
        role: true,
        lifecycleStatus: true,
        operatorMemberships: { select: { id: true }, take: 1 },
      },
    })
    if (!existing) return { kind: 'free' }

    if (
      existing.role === 'USER' &&
      existing.lifecycleStatus === 'ACTIVE' &&
      existing.operatorMemberships.length === 0
    ) {
      return { kind: 'linkable', userId: existing.id }
    }
    return { kind: 'taken' }
  }

  /**
   * Proves the caller actually owns the linkable account before any privilege is
   * granted on its behalf. Propagates whatever `IAuthProvider.signIn` throws on a
   * wrong password — a real authentication failure, distinct from "email taken".
   */
  verifyOwnership(email: string, password: string): Promise<AuthResult> {
    return this.auth.signIn({ email, password })
  }
}
