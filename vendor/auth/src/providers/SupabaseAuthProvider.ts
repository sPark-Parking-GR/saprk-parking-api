import type {
  AuthResult,
  AuthUser,
  PasswordResetRequest,
  SignInCredentials,
  SignUpData,
  TokenVerificationResult,
} from '@spark/types'
import type { IAuthProvider } from '../IAuthProvider'

export interface SupabaseAuthConfig {
  url: string
  serviceRoleKey: string
}

export class SupabaseAuthProvider implements IAuthProvider {
  readonly providerName = 'supabase'

  constructor(private readonly config: SupabaseAuthConfig) {}

  async signIn(_credentials: SignInCredentials): Promise<AuthResult> {
    throw new Error(
      'SupabaseAuthProvider.signIn: not implemented — install @supabase/supabase-js and use supabase.auth.signInWithPassword()',
    )
  }

  async signUp(_data: SignUpData): Promise<AuthResult> {
    throw new Error('SupabaseAuthProvider.signUp: not implemented — use supabase.auth.signUp()')
  }

  async signOut(_accessToken: string): Promise<void> {
    throw new Error('SupabaseAuthProvider.signOut: not implemented — use supabase.auth.signOut()')
  }

  async verifyToken(_accessToken: string): Promise<TokenVerificationResult | null> {
    throw new Error(
      'SupabaseAuthProvider.verifyToken: not implemented — use supabase.auth.getUser(token)',
    )
  }

  async refreshToken(_refreshToken: string): Promise<AuthResult> {
    throw new Error(
      'SupabaseAuthProvider.refreshToken: not implemented — use supabase.auth.refreshSession()',
    )
  }

  async resetPassword(_request: PasswordResetRequest, _newPassword: string): Promise<void> {
    throw new Error(
      'SupabaseAuthProvider.resetPassword: not implemented — use supabase.auth.admin.updateUserById(id, { password }) then supabase.auth.admin.signOut(jwt, "global")',
    )
  }

  async getUser(_userId: string): Promise<AuthUser | null> {
    throw new Error(
      'SupabaseAuthProvider.getUser: not implemented — use supabase.auth.admin.getUserById()',
    )
  }

  async deleteUser(_userId: string): Promise<void> {
    throw new Error(
      'SupabaseAuthProvider.deleteUser: not implemented — use supabase.auth.admin.deleteUser()',
    )
  }
  async findIdentityByEmail(_email: string): Promise<string | null> {
    throw new Error('SupabaseAuthProvider.findIdentityByEmail: not implemented')
  }

  async deleteIdentity(_identityId: string): Promise<void> {
    throw new Error('SupabaseAuthProvider.deleteIdentity: not implemented')
  }
}
