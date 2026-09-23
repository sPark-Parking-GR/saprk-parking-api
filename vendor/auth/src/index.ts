export type { IAuthProvider } from './IAuthProvider'
export { AuthContext } from './AuthContext'
export { createAuthProvider, createAuthContext } from './AuthFactory'
export type { AuthProviderConfig } from './AuthFactory'

export { AuthJsProvider } from './providers/AuthJsProvider'
export { FirebaseAuthProvider } from './providers/FirebaseAuthProvider'
export { CompositeAuthProvider } from './providers/CompositeAuthProvider'
export { ClerkProvider } from './providers/ClerkProvider'
export { SupabaseAuthProvider } from './providers/SupabaseAuthProvider'

export type {
  AuthJsConfig,
  AuthJsUserStore,
  AuthJsUserRecord,
  AuthJsCreateUserInput,
} from './providers/AuthJsProvider'
export type { FirebaseAuthConfig } from './providers/FirebaseAuthProvider'
export type { CompositeAuthConfig } from './providers/CompositeAuthProvider'
export type { ClerkConfig } from './providers/ClerkProvider'
export type { SupabaseAuthConfig } from './providers/SupabaseAuthProvider'

export {
  hashPassword,
  verifyPassword,
  needsRehash,
  CURRENT_SCRYPT_PARAMS,
  signJwt,
  verifyJwt,
} from './crypto'
export type { ScryptParams } from './crypto'
export { isRevokedByWatermark } from './revocation'
export {
  AuthError,
  InvalidCredentialsError,
  EmailInUseError,
  InvalidTokenError,
  WeakPasswordError,
} from './errors'
