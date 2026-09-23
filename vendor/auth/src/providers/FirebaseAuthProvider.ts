import type {
  AuthResult,
  AuthUser,
  PasswordResetRequest,
  SignInCredentials,
  SignUpData,
  TokenVerificationResult,
} from '@spark/types'
import * as admin from 'firebase-admin'
import type { IAuthProvider } from '../IAuthProvider'
import type { AuthJsUserRecord, AuthJsUserStore } from './AuthJsProvider'
import {
  EmailInUseError,
  WeakPasswordError,
  InvalidCredentialsError,
  InvalidTokenError,
} from '../errors'

export interface FirebaseAuthConfig {
  projectId: string
  clientEmail: string
  privateKey: string
  apiKey: string
  store: AuthJsUserStore
}

interface TokenBundle {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

interface SignInRestResponse {
  idToken: string
  refreshToken: string
  expiresIn: string
}

interface RefreshRestResponse {
  id_token: string
  refresh_token: string
  expires_in: string
}

const IDENTITY_TOOLKIT_URL = 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword'
const SECURE_TOKEN_URL = 'https://securetoken.googleapis.com/v1/token'

function firebaseErrorCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    return String((err as { code: unknown }).code)
  }
  return undefined
}

export class FirebaseAuthProvider implements IAuthProvider {
  readonly providerName = 'firebase'

  constructor(private readonly config: FirebaseAuthConfig) {}

  async signIn(credentials: SignInCredentials): Promise<AuthResult> {
    const email = credentials.email.toLowerCase()
    const record = await this.config.store.findByEmail(email)
    if (!record) throw new InvalidCredentialsError()
    const tokens = await this.restSignIn(email, credentials.password)
    return this.toResult(record, tokens)
  }

  async signUp(data: SignUpData): Promise<AuthResult> {
    const email = data.email.toLowerCase()
    const role = data.role ?? 'user'

    let firebaseUid: string
    try {
      const created = await this.auth().createUser({
        email,
        password: data.password,
        displayName: data.displayName,
        emailVerified: false,
      })
      firebaseUid = created.uid
    } catch (err) {
      const code = firebaseErrorCode(err)
      if (code === 'auth/email-already-exists') throw new EmailInUseError()
      // Firebase enforces a six-character floor of its own. Our schemas ask for more, so
      // this is only reachable by a caller that bypassed them — but rethrowing raw turned
      // a bad request into a 500 with a Google stack in the log.
      if (code === 'auth/invalid-password' || code === 'auth/weak-password') {
        throw new WeakPasswordError()
      }
      throw err
    }

    let record: AuthJsUserRecord
    try {
      // Firebase owns the credential, so there is no local password hash; the
      // empty string is this codebase's sentinel for "no local password".
      record = await this.config.store.createUser({
        email,
        passwordHash: '',
        role,
        firebaseUid,
        ...(data.displayName ? { displayName: data.displayName } : {}),
      })
    } catch (err) {
      await this.auth()
        .deleteUser(firebaseUid)
        .catch(() => undefined)
      throw err
    }

    try {
      await this.auth().setCustomUserClaims(firebaseUid, {
        localUserId: record.id,
        role: record.role,
      })
      const tokens = await this.restSignIn(email, data.password)
      return this.toResult(record, tokens)
    } catch (err) {
      // Both identities already exist at this point; a failure here (e.g. the REST
      // sign-in call, most commonly because Email/Password sign-in isn't enabled on
      // the Firebase project yet) must not leave an orphaned Firebase+local user.
      await this.auth()
        .deleteUser(firebaseUid)
        .catch(() => undefined)
      await this.config.store.deleteUser(record.id).catch(() => undefined)
      throw err
    }
  }

  // Revocation has to happen on both sides. Google's revokeRefreshTokens stops its own
  // token endpoint minting fresh ID tokens, but says nothing about ID tokens already in
  // the wild, which stay cryptographically valid for up to an hour; the local watermark
  // is what rejects those. Like the authjs provider this is all-devices — there is no
  // per-session table.
  async signOut(accessToken: string): Promise<void> {
    let decoded: admin.auth.DecodedIdToken
    try {
      decoded = await this.auth().verifyIdToken(accessToken)
    } catch {
      // Forgiving by contract: an invalid or expired token has nothing to revoke.
      return
    }
    await this.auth().revokeRefreshTokens(decoded.uid)
    const localUserId = typeof decoded.localUserId === 'string' ? decoded.localUserId : null
    if (localUserId) await this.config.store.revokeSessions(localUserId, new Date())
  }

  async verifyToken(accessToken: string): Promise<TokenVerificationResult | null> {
    let decoded: admin.auth.DecodedIdToken
    try {
      decoded = await this.auth().verifyIdToken(accessToken)
    } catch {
      return null
    }
    const localUserId = typeof decoded.localUserId === 'string' ? decoded.localUserId : null
    if (!localUserId) return null
    const record = await this.config.store.findById(localUserId)
    if (!record) return null
    return { user: this.recordToUser(record), isExpired: false, issuedAt: decoded.iat }
  }

  async refreshToken(refreshToken: string): Promise<AuthResult> {
    const res = await fetch(`${SECURE_TOKEN_URL}?key=${this.config.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }).toString(),
    })
    if (!res.ok) throw new InvalidTokenError()
    const body = (await res.json()) as RefreshRestResponse

    let decoded: admin.auth.DecodedIdToken
    try {
      decoded = await this.auth().verifyIdToken(body.id_token)
    } catch {
      throw new InvalidTokenError()
    }
    const localUserId = typeof decoded.localUserId === 'string' ? decoded.localUserId : null
    if (!localUserId) throw new InvalidTokenError()
    const record = await this.config.store.findById(localUserId)
    if (!record) throw new InvalidTokenError()

    return this.toResult(record, {
      accessToken: body.id_token,
      refreshToken: body.refresh_token,
      expiresAt: Date.now() + Number(body.expires_in) * 1000,
    })
  }

  // Google owns the credential, so the new password is written there via the Admin SDK
  // rather than through a Google-hosted reset link — that keeps completion inside this API,
  // which is the only way the local watermark below can be bumped at the moment of reset.
  // Revocation is two-sided for the same reason signOut is: revokeRefreshTokens stops
  // Google minting fresh ID tokens, the watermark rejects the ones already in the wild.
  async resetPassword(request: PasswordResetRequest, newPassword: string): Promise<void> {
    const record = await this.config.store.findByEmail(request.email.toLowerCase())
    if (!record?.firebaseUid) throw new InvalidTokenError()
    await this.auth().updateUser(record.firebaseUid, { password: newPassword })
    await this.auth().revokeRefreshTokens(record.firebaseUid)
    await this.config.store.revokeSessions(record.id, new Date())
  }

  async getUser(userId: string): Promise<AuthUser | null> {
    const record = await this.config.store.findById(userId)
    return record ? this.recordToUser(record) : null
  }

  async deleteUser(userId: string): Promise<void> {
    const record = await this.config.store.findById(userId)
    if (record?.firebaseUid) await this.deleteIdentity(record.firebaseUid)
    await this.config.store.deleteUser(userId)
  }

  /**
   * Resolves the Google-side identity for an address, or null when none exists. Absent is a
   * legitimate answer, not a failure — the caller is asking whether a credential is there.
   *
   * Needed because a purge nulls firebaseUid and anonymises the email, so a credential
   * stranded by a purge that ran before the release path existed can no longer be named by
   * uid. The address is the only handle left.
   */
  async findIdentityByEmail(email: string): Promise<string | null> {
    try {
      const record = await this.auth().getUserByEmail(email.toLowerCase())
      return record.uid
    } catch (err) {
      if (firebaseErrorCode(err) === 'auth/user-not-found') return null
      throw err
    }
  }

  // Removes the Google-side identity and leaves the local store alone. Account deletion
  // cannot go through deleteUser above: it keeps the local row as an anonymised tombstone
  // because bookings reference it, but the remote credential must still be destroyed or
  // the address stays registered with Google forever. Absent is success — the only
  // outcome this method exists to guarantee is that the uid no longer resolves.
  async deleteIdentity(firebaseUid: string): Promise<void> {
    await this.auth()
      .deleteUser(firebaseUid)
      .catch((err: unknown) => {
        if (firebaseErrorCode(err) !== 'auth/user-not-found') throw err
      })
  }

  private app(): admin.app.App {
    return admin.apps.length
      ? admin.app()
      : admin.initializeApp({
          credential: admin.credential.cert({
            projectId: this.config.projectId,
            clientEmail: this.config.clientEmail,
            // .env stores the PEM with literal "\n" sequences; the PEM decoder needs
            // real newline bytes.
            privateKey: this.config.privateKey.replace(/\\n/g, '\n'),
          }),
        })
  }

  private auth(): admin.auth.Auth {
    return admin.auth(this.app())
  }

  private async restSignIn(email: string, password: string): Promise<TokenBundle> {
    const res = await fetch(`${IDENTITY_TOOLKIT_URL}?key=${this.config.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    })
    if (!res.ok) {
      // The client only ever sees a generic InvalidCredentialsError (never leak which
      // part failed), but a misconfigured project (e.g. Email/Password sign-in not
      // enabled in the Firebase console) is otherwise undiagnosable from the outside.
      // The response body can echo the submitted email back, so only the status —
      // never the body — is logged.
      console.error(`[FirebaseAuthProvider] Identity Toolkit sign-in failed (${res.status})`)
      throw new InvalidCredentialsError()
    }
    const body = (await res.json()) as SignInRestResponse
    return {
      accessToken: body.idToken,
      refreshToken: body.refreshToken,
      expiresAt: Date.now() + Number(body.expiresIn) * 1000,
    }
  }

  private toResult(record: AuthJsUserRecord, tokens: TokenBundle): AuthResult {
    return {
      session: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        user: this.recordToUser(record),
      },
    }
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
}
