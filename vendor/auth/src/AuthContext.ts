import type {
  AuthResult,
  AuthUser,
  PasswordResetRequest,
  SignInCredentials,
  SignUpData,
  TokenVerificationResult,
} from '@spark/types'
import type { IAuthProvider } from './IAuthProvider'

export class AuthContext {
  constructor(private provider: IAuthProvider) {}

  get providerName(): string {
    return this.provider.providerName
  }

  setProvider(provider: IAuthProvider): void {
    this.provider = provider
  }

  signIn(credentials: SignInCredentials): Promise<AuthResult> {
    return this.provider.signIn(credentials)
  }

  signUp(data: SignUpData): Promise<AuthResult> {
    return this.provider.signUp(data)
  }

  signOut(accessToken: string): Promise<void> {
    return this.provider.signOut(accessToken)
  }

  verifyToken(accessToken: string): Promise<TokenVerificationResult | null> {
    return this.provider.verifyToken(accessToken)
  }

  refreshToken(refreshToken: string): Promise<AuthResult> {
    return this.provider.refreshToken(refreshToken)
  }

  resetPassword(request: PasswordResetRequest, newPassword: string): Promise<void> {
    return this.provider.resetPassword(request, newPassword)
  }

  getUser(userId: string): Promise<AuthUser | null> {
    return this.provider.getUser(userId)
  }

  deleteUser(userId: string): Promise<void> {
    return this.provider.deleteUser(userId)
  }

  findIdentityByEmail(email: string): Promise<string | null> {
    return this.provider.findIdentityByEmail(email)
  }

  deleteIdentity(identityId: string): Promise<void> {
    return this.provider.deleteIdentity(identityId)
  }
}
