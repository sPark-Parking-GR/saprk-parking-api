import type {
  AuthResult,
  AuthUser,
  PasswordResetRequest,
  SignInCredentials,
  SignUpData,
  TokenVerificationResult,
} from '@spark/types'
import type { IAuthProvider } from '../IAuthProvider'

export interface ClerkConfig {
  secretKey: string
  publishableKey: string
}

export class ClerkProvider implements IAuthProvider {
  readonly providerName = 'clerk'

  constructor(private readonly config: ClerkConfig) {}

  async signIn(_credentials: SignInCredentials): Promise<AuthResult> {
    throw new Error(
      'ClerkProvider.signIn: not implemented — install @clerk/backend and use clerkClient.signInTokens.createSignInToken()',
    )
  }

  async signUp(_data: SignUpData): Promise<AuthResult> {
    throw new Error('ClerkProvider.signUp: not implemented — use clerkClient.users.createUser()')
  }

  async signOut(_accessToken: string): Promise<void> {
    throw new Error(
      'ClerkProvider.signOut: not implemented — use clerkClient.sessions.revokeSession()',
    )
  }

  async verifyToken(_accessToken: string): Promise<TokenVerificationResult | null> {
    throw new Error(
      'ClerkProvider.verifyToken: not implemented — use verifyToken() from @clerk/backend',
    )
  }

  async refreshToken(_refreshToken: string): Promise<AuthResult> {
    throw new Error(
      'ClerkProvider.refreshToken: not implemented — Clerk manages session lifecycle automatically',
    )
  }

  async resetPassword(_request: PasswordResetRequest, _newPassword: string): Promise<void> {
    throw new Error(
      'ClerkProvider.resetPassword: not implemented — use clerkClient.users.updateUser({ password }) then clerkClient.sessions.revokeSession() for each active session',
    )
  }

  async getUser(_userId: string): Promise<AuthUser | null> {
    throw new Error('ClerkProvider.getUser: not implemented — use clerkClient.users.getUser()')
  }

  async deleteUser(_userId: string): Promise<void> {
    throw new Error(
      'ClerkProvider.deleteUser: not implemented — use clerkClient.users.deleteUser()',
    )
  }
  async findIdentityByEmail(_email: string): Promise<string | null> {
    throw new Error('ClerkProvider.findIdentityByEmail: not implemented')
  }

  async deleteIdentity(_identityId: string): Promise<void> {
    throw new Error('ClerkProvider.deleteIdentity: not implemented')
  }
}
