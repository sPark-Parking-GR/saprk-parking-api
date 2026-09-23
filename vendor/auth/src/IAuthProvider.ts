import type {
  AuthResult,
  AuthUser,
  PasswordResetRequest,
  SignInCredentials,
  SignUpData,
  TokenVerificationResult,
} from '@spark/types'

export interface IAuthProvider {
  readonly providerName: string

  signIn(credentials: SignInCredentials): Promise<AuthResult>

  signUp(data: SignUpData): Promise<AuthResult>

  signOut(accessToken: string): Promise<void>

  verifyToken(accessToken: string): Promise<TokenVerificationResult | null>

  refreshToken(refreshToken: string): Promise<AuthResult>

  // Applies an already-authorised new password to whichever backend owns the credential,
  // and revokes the account's existing sessions. Proving the requester owns the address —
  // issuing the reset grant and emailing it — belongs to the host app, which is where the
  // token store and the notification channel live.
  resetPassword(request: PasswordResetRequest, newPassword: string): Promise<void>

  getUser(userId: string): Promise<AuthUser | null>

  deleteUser(userId: string): Promise<void>

  /**
   * The REMOTE identity for an address, if the provider keeps one, or null.
   *
   * Part of the port rather than a Firebase extra because three host services — account
   * deletion, the lifecycle purge and the reconcile CLI — need it, and typing them against
   * the concrete Firebase class is what made those paths break outright under any other
   * provider. A provider that owns no remote identity answers null, which is the truthful
   * answer and the one every caller already handles.
   */
  findIdentityByEmail(email: string): Promise<string | null>

  /**
   * Destroys the remote identity and leaves the local row alone.
   *
   * Distinct from deleteUser: a purge keeps the local row as an anonymised tombstone
   * because bookings reference it, while the credential must still be destroyed or the
   * address stays registered with the provider for ever. A provider with no remote side
   * has nothing to destroy and resolves.
   */
  deleteIdentity(identityId: string): Promise<void>
}
