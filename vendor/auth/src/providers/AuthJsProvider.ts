import type {
  AuthResult,
  AuthUser,
  PasswordResetRequest,
  SignInCredentials,
  SignUpData,
  TokenVerificationResult,
  UserRole,
} from '@spark/types'
import type { IAuthProvider } from '../IAuthProvider'
import type { ScryptParams } from '../crypto'
import {
  CURRENT_SCRYPT_PARAMS,
  hashPassword,
  needsRehash,
  signJwt,
  verifyJwt,
  verifyPassword,
} from '../crypto'
import { EmailInUseError, InvalidCredentialsError, InvalidTokenError } from '../errors'
import { isRevokedByWatermark } from '../revocation'

export interface AuthJsUserRecord {
  id: string
  email: string
  role: UserRole
  emailVerified: boolean
  displayName?: string | null
  avatarUrl?: string | null
  passwordHash: string
  // Set for Firebase-provisioned identities so a Firebase-backed provider can
  // round-trip the remote uid through the same shared store contract; null for
  // password-credential (authjs) users.
  firebaseUid?: string | null
  // Session revocation watermark; null for users who have never revoked.
  sessionsValidFrom?: Date | null
}

export interface AuthJsCreateUserInput {
  email: string
  passwordHash: string
  role: UserRole
  displayName?: string
  firebaseUid?: string
}

// The DB-backed user repository is injected by the host app so this package keeps
// zero runtime dependencies (no Prisma, no ORM) — only @spark/types and node builtins.
export interface AuthJsUserStore {
  findByEmail(email: string): Promise<AuthJsUserRecord | null>
  findById(id: string): Promise<AuthJsUserRecord | null>
  createUser(input: AuthJsCreateUserInput): Promise<AuthJsUserRecord>
  deleteUser(id: string): Promise<void>
  updatePassword(id: string, passwordHash: string): Promise<void>
  // Conditional variant for opportunistic rehashing: must write only if the stored hash
  // is still `expectedHash`, and silently do nothing otherwise.
  upgradePassword(id: string, expectedHash: string, passwordHash: string): Promise<void>
  revokeSessions(id: string, at: Date): Promise<void>
}

export interface AuthJsConfig {
  secret: string
  store: AuthJsUserStore
  accessTtlSeconds?: number
  refreshTtlSeconds?: number
  passwordParams?: ScryptParams
  onPasswordUpgradeError?: (error: unknown, userId: string) => void
}

const DEFAULT_ACCESS_TTL = 60 * 15
const DEFAULT_REFRESH_TTL = 60 * 60 * 24 * 30
const MIN_SECRET_LENGTH = 32

interface AccessClaims {
  sub: string
  email: string
  role: UserRole
  ev: boolean
  dn?: string
  av?: string
  typ: 'access'
  iat: number
  exp: number
}

interface RefreshClaims {
  sub: string
  typ: 'refresh'
  iat: number
  exp: number
}

export class AuthJsProvider implements IAuthProvider {
  readonly providerName = 'authjs'

  private readonly accessTtl: number
  private readonly refreshTtl: number
  private readonly passwordParams: ScryptParams

  constructor(private readonly config: AuthJsConfig) {
    if (!config.secret || config.secret.length < MIN_SECRET_LENGTH) {
      throw new Error(
        `AuthJsProvider requires a secret of at least ${MIN_SECRET_LENGTH} characters`,
      )
    }
    this.accessTtl = config.accessTtlSeconds ?? DEFAULT_ACCESS_TTL
    this.refreshTtl = config.refreshTtlSeconds ?? DEFAULT_REFRESH_TTL
    this.passwordParams = config.passwordParams ?? CURRENT_SCRYPT_PARAMS
  }

  async signIn(credentials: SignInCredentials): Promise<AuthResult> {
    const record = await this.config.store.findByEmail(credentials.email.toLowerCase())
    if (!record || !(await verifyPassword(credentials.password, record.passwordHash))) {
      throw new InvalidCredentialsError()
    }
    await this.upgradePasswordHash(record, credentials.password)
    return this.issue(record)
  }

  // Opportunistic migration off legacy and below-cost hashes, which is the only way the
  // existing population moves to the current parameters without a forced reset.
  private async upgradePasswordHash(record: AuthJsUserRecord, plain: string): Promise<void> {
    if (!needsRehash(record.passwordHash, this.passwordParams)) return
    try {
      // Conditional on the hash we verified against: hashing takes ~400ms, and an
      // unconditional write would let a password reset that landed inside that window be
      // overwritten by the old credential — silently undoing the reset.
      await this.config.store.upgradePassword(
        record.id,
        record.passwordHash,
        await hashPassword(plain, this.passwordParams),
      )
    } catch (error) {
      // The credential was already verified, so this is strictly an optimisation. Letting
      // a failed store write escape would convert a correct sign-in into a 500 and take
      // authentication down with the database — the user stays on the old hash instead.
      this.config.onPasswordUpgradeError?.(error, record.id)
    }
  }

  async signUp(data: SignUpData): Promise<AuthResult> {
    const email = data.email.toLowerCase()
    const existing = await this.config.store.findByEmail(email)
    if (existing) throw new EmailInUseError()

    const record = await this.config.store.createUser({
      email,
      passwordHash: await hashPassword(data.password, this.passwordParams),
      role: data.role ?? 'user',
      ...(data.displayName ? { displayName: data.displayName } : {}),
    })
    return this.issue(record)
  }

  // Sign-out is all-devices: without a per-session table the watermark IS the entire
  // revocation state, so it kills every token the user holds. Accepted tradeoff for v1.
  // Expiry is deliberately not checked — a 15-minute access token is usually already
  // dead by the time someone signs out, and it must still be able to kill the 30-day
  // refresh token it was issued with.
  async signOut(accessToken: string): Promise<void> {
    const claims = verifyJwt<AccessClaims>(accessToken, this.config.secret)
    if (!claims || claims.typ !== 'access') return
    await this.config.store.revokeSessions(claims.sub, new Date())
  }

  async verifyToken(accessToken: string): Promise<TokenVerificationResult | null> {
    const claims = verifyJwt<AccessClaims>(accessToken, this.config.secret)
    if (!claims || claims.typ !== 'access') return null
    return {
      user: this.claimsToUser(claims),
      isExpired: this.isExpired(claims.exp),
      issuedAt: claims.iat,
    }
  }

  async refreshToken(refreshToken: string): Promise<AuthResult> {
    const claims = verifyJwt<RefreshClaims>(refreshToken, this.config.secret)
    if (!claims || claims.typ !== 'refresh' || this.isExpired(claims.exp)) {
      throw new InvalidTokenError()
    }
    const record = await this.config.store.findById(claims.sub)
    if (!record) throw new InvalidTokenError()
    // The refresh endpoint is where revocation actually pays off: it is the only thing
    // standing between a stolen refresh token and 30 more days of valid sessions.
    if (isRevokedByWatermark(claims.iat, record.sessionsValidFrom)) throw new InvalidTokenError()
    return this.issue(record)
  }

  // Revoking here is the whole point of a reset: without the watermark bump the refresh
  // token an attacker already holds keeps minting sessions for 30 more days against the
  // new password.
  async resetPassword(request: PasswordResetRequest, newPassword: string): Promise<void> {
    const record = await this.config.store.findByEmail(request.email.toLowerCase())
    if (!record) throw new InvalidTokenError()
    await this.config.store.updatePassword(
      record.id,
      await hashPassword(newPassword, this.passwordParams),
    )
    await this.config.store.revokeSessions(record.id, new Date())
  }

  async getUser(userId: string): Promise<AuthUser | null> {
    const record = await this.config.store.findById(userId)
    return record ? this.recordToUser(record) : null
  }

  async deleteUser(userId: string): Promise<void> {
    await this.config.store.deleteUser(userId)
  }

  /**
   * There is no remote identity: this provider's credential IS the local row's scrypt hash.
   * Null is the accurate answer to "what is registered elsewhere for this address", and it
   * is what every caller already does the right thing with — the purge skips the release
   * step, the reconcile CLI reports nothing stranded.
   */
  async findIdentityByEmail(): Promise<string | null> {
    return null
  }

  /** Nothing to destroy, for the same reason. Resolving is success, not a silent failure. */
  async deleteIdentity(): Promise<void> {
    return undefined
  }

  private issue(record: AuthJsUserRecord): AuthResult {
    const now = Math.floor(Date.now() / 1000)
    const accessExp = now + this.accessTtl
    const user = this.recordToUser(record)

    const accessToken = signJwt(
      {
        sub: user.id,
        email: user.email,
        role: user.role,
        ev: user.emailVerified,
        ...(user.displayName ? { dn: user.displayName } : {}),
        ...(user.avatarUrl ? { av: user.avatarUrl } : {}),
        typ: 'access',
        iat: now,
        exp: accessExp,
      },
      this.config.secret,
    )

    const refreshToken = signJwt(
      { sub: user.id, typ: 'refresh', iat: now, exp: now + this.refreshTtl },
      this.config.secret,
    )

    return {
      session: { accessToken, refreshToken, expiresAt: accessExp * 1000, user },
    }
  }

  private isExpired(exp: number): boolean {
    return Math.floor(Date.now() / 1000) >= exp
  }

  private recordToUser(record: AuthJsUserRecord): AuthUser {
    return {
      id: record.id,
      email: record.email,
      role: record.role,
      emailVerified: record.emailVerified,
      ...(record.displayName ? { displayName: record.displayName } : {}),
      ...(record.avatarUrl ? { avatarUrl: record.avatarUrl } : {}),
    }
  }

  private claimsToUser(claims: AccessClaims): AuthUser {
    return {
      id: claims.sub,
      email: claims.email,
      role: claims.role,
      emailVerified: claims.ev,
      ...(claims.dn ? { displayName: claims.dn } : {}),
      ...(claims.av ? { avatarUrl: claims.av } : {}),
    }
  }
}
