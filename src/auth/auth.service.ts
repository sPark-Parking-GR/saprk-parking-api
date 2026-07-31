import { Inject, Injectable } from '@nestjs/common'
import type { AuthContext } from '@spark/auth'
import type { AuthResult, SignInCredentials, TokenVerificationResult } from '@spark/types'
import { OperatorStatusService } from '../common/authz/operator-status.service'
import { AUTH_CONTEXT_TOKEN } from './auth.constants'
import type { SignUpDto } from './dto/auth.dto'

@Injectable()
export class AuthService {
  constructor(
    @Inject(AUTH_CONTEXT_TOKEN) private readonly auth: AuthContext,
    private readonly operatorStatus: OperatorStatusService,
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
