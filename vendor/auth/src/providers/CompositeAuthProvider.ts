import type {
  AuthResult,
  AuthUser,
  PasswordResetRequest,
  SignInCredentials,
  SignUpData,
  TokenVerificationResult,
} from '@spark/types'
import type { IAuthProvider } from '../IAuthProvider'

/** Which backend actually holds an existing account's credential. */
export type CredentialOwner = 'firebase' | 'local'

export interface CompositeAuthConfig {
  /** Where NEW accounts are created — the strategy AUTH_PROVIDER selected. */
  default: IAuthProvider

  /**
   * Owns accounts carrying a firebaseUid. Null when the deployment has configured no
   * Firebase credentials, in which case every route falls back to the default.
   */
  firebase: IAuthProvider | null

  /**
   * Owns accounts carrying a local password hash. Null when there is no local secret to
   * verify one with.
   *
   * Present even when it is NOT the default, and that is the whole point: routing was
   * previously "firebase, or else the default", which worked only while the default was the
   * local provider. Selecting AUTH_PROVIDER=firebase sent every seeded, bootstrapped and
   * previously-authjs account to Firebase, which holds no credential for them — so the
   * switch that is supposed to be a config change locked out every existing user. Naming
   * both owners explicitly is what makes the strategy switchable in both directions.
   */
  local: IAuthProvider | null

  resolveByEmail: (email: string) => Promise<CredentialOwner | null>
}

const FIREBASE_ISS_PREFIX = 'https://securetoken.google.com/'

// Unverified payload peek used only to route a token to the right concrete
// provider; the chosen provider performs real cryptographic verification.
function decodeJwtIssuer(token: string): string | null {
  const payload = token.split('.')[1]
  if (!payload) return null
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      iss?: unknown
    }
    return typeof claims.iss === 'string' ? claims.iss : null
  } catch {
    return null
  }
}

// Three dot-separated, non-empty segments. Deliberately structural only — the segments are
// not decoded and nothing is verified here; this answers "could this be a JWT at all", which
// is what tells an authjs refresh token apart from Firebase's opaque one.
function isJwtShaped(token: string): boolean {
  const parts = token.split('.')
  return parts.length === 3 && parts.every((part) => part.length > 0)
}

export class CompositeAuthProvider implements IAuthProvider {
  readonly providerName = 'composite'

  constructor(private readonly config: CompositeAuthConfig) {}

  async signIn(credentials: SignInCredentials): Promise<AuthResult> {
    return (await this.byEmail(credentials.email)).signIn(credentials)
  }

  async signUp(data: SignUpData): Promise<AuthResult> {
    return (await this.byEmail(data.email)).signUp(data)
  }

  async signOut(accessToken: string): Promise<void> {
    return this.byToken(accessToken).signOut(accessToken)
  }

  async verifyToken(accessToken: string): Promise<TokenVerificationResult | null> {
    return this.byToken(accessToken).verifyToken(accessToken)
  }

  async refreshToken(refreshToken: string): Promise<AuthResult> {
    return this.byRefreshToken(refreshToken).refreshToken(refreshToken)
  }

  async resetPassword(request: PasswordResetRequest, newPassword: string): Promise<void> {
    return (await this.byEmail(request.email)).resetPassword(request, newPassword)
  }

  // Both providers read the same local store for user data, so either returns
  // the same row; default is the cheaper path (no Firebase lookup).
  async getUser(userId: string): Promise<AuthUser | null> {
    return this.config.default.getUser(userId)
  }

  /**
   * The Firebase provider's delete is a safe superset: it removes the remote identity when
   * a firebaseUid is present and otherwise deletes only the local row, so routing here
   * avoids orphaning identities for accounts that have one.
   *
   * Guarded on the firebase leg actually being configured. With AUTH_PROVIDER=authjs and no
   * Firebase credentials this used to be an unconditional call into a provider that could
   * not initialise — the delete path was broken by construction rather than by data.
   */
  async deleteUser(userId: string): Promise<void> {
    return (this.config.firebase ?? this.config.default).deleteUser(userId)
  }

  // Asked of the remote-identity provider when there is one; the default answers null when
  // it owns no remote side, which is the truthful answer either way.
  async findIdentityByEmail(email: string): Promise<string | null> {
    return (this.config.firebase ?? this.config.default).findIdentityByEmail(email.toLowerCase())
  }

  async deleteIdentity(identityId: string): Promise<void> {
    return (this.config.firebase ?? this.config.default).deleteIdentity(identityId)
  }

  // An address with no account resolves to null and goes to the default — which is correct
  // for signUp, and for signIn is the provider best placed to say "no such account".
  private async byEmail(email: string): Promise<IAuthProvider> {
    const owner = await this.config.resolveByEmail(email.toLowerCase())
    return this.legFor(owner)
  }

  private legFor(owner: CredentialOwner | null): IAuthProvider {
    if (owner === 'firebase') return this.config.firebase ?? this.config.default
    if (owner === 'local') return this.config.local ?? this.config.default
    return this.config.default
  }

  // A Firebase-issued token is unmistakable; anything else that parses as a JWT is the
  // local provider's, whether or not the local provider is the default.
  private byToken(token: string): IAuthProvider {
    const iss = decodeJwtIssuer(token)
    return this.legFor(iss?.startsWith(FIREBASE_ISS_PREFIX) ? 'firebase' : 'local')
  }

  /**
   * Refresh tokens need their own router, because only ACCESS tokens are JWTs.
   *
   * Firebase hands back an opaque Google string (`AMf-vB…`, no dots at all), so routing it
   * through byToken meant decodeJwtIssuer found no payload, answered null, and sent it to
   * the default provider — which under AUTH_PROVIDER=authjs tried to HMAC-verify a Google
   * string and rejected it. Every Firebase-backed account was therefore unable to renew a
   * session: once the one-hour access token lapsed, the refresh that should have replaced
   * it failed and the person was signed out.
   *
   * Shape is the discriminator, and a sound one for these two providers: authjs signs its
   * refresh token as a JWT, Firebase's is opaque. So a token that does not parse as a JWT
   * cannot be an authjs one. It is still checked against the issuer first, so a JWT that
   * genuinely is Firebase's routes correctly, and neither provider is assumed to be the
   * default — this works whichever one AUTH_PROVIDER selected.
   */
  private byRefreshToken(token: string): IAuthProvider {
    const iss = decodeJwtIssuer(token)
    if (iss?.startsWith(FIREBASE_ISS_PREFIX)) return this.legFor('firebase')
    // Opaque means Firebase: the local provider signs its refresh token as a JWT.
    return this.legFor(isJwtShaped(token) ? 'local' : 'firebase')
  }
}
