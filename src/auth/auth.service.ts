import { Inject, Injectable } from '@nestjs/common'
import type { AuthContext } from '@spark/auth'
import type { AuthResult, SignInCredentials, SignUpData, TokenVerificationResult } from '@spark/types'
import { OperatorStatusService } from '../common/authz/operator-status.service'
import { AUTH_CONTEXT_TOKEN } from './auth.constants'

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

  signUp(data: SignUpData): Promise<AuthResult> {
    return this.auth.signUp(data)
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
