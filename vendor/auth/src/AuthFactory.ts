import { AuthContext } from './AuthContext'
import type { IAuthProvider } from './IAuthProvider'
import { AuthJsProvider } from './providers/AuthJsProvider'
import { ClerkProvider } from './providers/ClerkProvider'
import { CompositeAuthProvider } from './providers/CompositeAuthProvider'
import { FirebaseAuthProvider } from './providers/FirebaseAuthProvider'
import { SupabaseAuthProvider } from './providers/SupabaseAuthProvider'
import type { AuthJsConfig } from './providers/AuthJsProvider'
import type { ClerkConfig } from './providers/ClerkProvider'
import type { CompositeAuthConfig } from './providers/CompositeAuthProvider'
import type { FirebaseAuthConfig } from './providers/FirebaseAuthProvider'
import type { SupabaseAuthConfig } from './providers/SupabaseAuthProvider'

export type AuthProviderConfig =
  | { provider: 'authjs'; config: AuthJsConfig }
  | { provider: 'firebase'; config: FirebaseAuthConfig }
  | { provider: 'clerk'; config: ClerkConfig }
  | { provider: 'supabase'; config: SupabaseAuthConfig }
  | { provider: 'composite'; config: CompositeAuthConfig }

export function createAuthProvider(options: AuthProviderConfig): IAuthProvider {
  switch (options.provider) {
    case 'authjs':
      return new AuthJsProvider(options.config)
    case 'firebase':
      return new FirebaseAuthProvider(options.config)
    case 'clerk':
      return new ClerkProvider(options.config)
    case 'supabase':
      return new SupabaseAuthProvider(options.config)
    case 'composite':
      return new CompositeAuthProvider(options.config)
  }
}

export function createAuthContext(options: AuthProviderConfig): AuthContext {
  return new AuthContext(createAuthProvider(options))
}
