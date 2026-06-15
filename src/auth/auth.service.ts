import { Inject, Injectable } from '@nestjs/common'
import type { AuthContext } from '@parqin/auth'
import type { AuthResult, SignInCredentials, SignUpData, TokenVerificationResult } from '@parqin/types'
import { AUTH_CONTEXT_TOKEN } from './auth.constants'

@Injectable()
export class AuthService {
  constructor(@Inject(AUTH_CONTEXT_TOKEN) private readonly auth: AuthContext) {}

  get providerName(): string {
    return this.auth.providerName
  }

  signIn(credentials: SignInCredentials): Promise<AuthResult> {
    return this.auth.signIn(credentials)
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

  refreshToken(refreshToken: string): Promise<AuthResult> {
    return this.auth.refreshToken(refreshToken)
  }
}
