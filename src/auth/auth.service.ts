import { Inject, Injectable } from '@nestjs/common'
import type { AuthContext } from '@spark/auth'
import type { AuthResult, AuthUser, SignInCredentials, TokenVerificationResult } from '@spark/types'
import { OperatorStatusService } from '../common/authz/operator-status.service'
import { PrismaService } from '../prisma/prisma.service'
import { AUTH_CONTEXT_TOKEN } from './auth.constants'
import type { SignUpDto } from './dto/auth.dto'

@Injectable()
export class AuthService {
  constructor(
    @Inject(AUTH_CONTEXT_TOKEN) private readonly auth: AuthContext,
    private readonly operatorStatus: OperatorStatusService,
    private readonly prisma: PrismaService,
  ) {}

  get providerName(): string {
    return this.auth.providerName
  }

  async signIn(credentials: SignInCredentials): Promise<AuthResult> {
    const result = await this.auth.signIn(credentials)
    await this.operatorStatus.assertOperatorActive(result.session.user)
    return result
  }

  // Role is pinned here rather than passed through, so no caller of this method can ever
  // elevate. The provider-level SignUpData still allows 'operator_admin' because the
  // invite flow legitimately needs it — that path calls the provider directly.
  signUp(data: SignUpDto): Promise<AuthResult> {
    return this.auth.signUp({ ...data, role: 'user' })
  }

  signOut(accessToken: string): Promise<void> {
    return this.auth.signOut(accessToken)
  }

  /**
   * Writes the local User row directly rather than going through IAuthProvider.
   *
   * displayName is local-only state: both providers read it from the same Postgres row via
   * PrismaAuthJsUserStore, and Firebase's own copy is never read back — recordToUser builds
   * the AuthUser from the local record. Adding a mutation to the port would oblige every
   * future provider to implement something none of them own.
   */
  async updateProfile(userId: string, displayName: string | null): Promise<AuthUser> {
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { displayName },
      select: {
        id: true,
        email: true,
        role: true,
        emailVerified: true,
        displayName: true,
        avatarUrl: true,
      },
    })
    return {
      id: updated.id,
      email: updated.email,
      role: updated.role.toLowerCase() as AuthUser['role'],
      emailVerified: updated.emailVerified,
      ...(updated.displayName ? { displayName: updated.displayName } : {}),
      ...(updated.avatarUrl ? { avatarUrl: updated.avatarUrl } : {}),
    }
  }

  verifyToken(accessToken: string): Promise<TokenVerificationResult | null> {
    return this.auth.verifyToken(accessToken)
  }

  async refreshToken(refreshToken: string): Promise<AuthResult> {
    // AuthGuard only sees bearer headers, and /auth/refresh is @Public() with the token
    // in the body — without this check a suspended operator could keep minting tokens.
    const result = await this.auth.refreshToken(refreshToken)
    await this.operatorStatus.assertOperatorActive(result.session.user)
    return result
  }
}
