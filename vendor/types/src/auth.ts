export type UserRole =
  'guest' | 'user' | 'operator_staff' | 'operator_admin' | 'platform_admin' | 'super_admin'

/**
 * The platform-administration capabilities, kept deliberately separate from UserRole so
 * that what a caller MAY DO is decoupled from what a caller IS. Operations here differ by
 * orders of magnitude in blast radius — reading a tenant is not editing it, and neither is
 * destroying it — and a single `platform_admin` boolean cannot express that.
 *
 * Public contract: the API guards, the web dashboard and the mobile app all resolve these
 * same strings against the same map below, so none of them can disagree about who may do
 * what.
 *
 * TENANT capabilities only. Anything that acts on a user ACCOUNT lives in
 * IDENTITY_PERMISSIONS below, and the split is the entire boundary between platform_admin
 * and super_admin — see the comment there before moving a permission across it.
 */
export const PLATFORM_PERMISSIONS = [
  /** Read any tenant's data across the whole platform, ignoring operator scoping. */
  'platform:tenant.read',
  /** Create or mutate any tenant's data, including lifecycle state such as suspension. */
  'platform:tenant.write',
  /** Irreversibly destroy tenant data. Never implied by `platform:tenant.write`. */
  'platform:tenant.purge',
  /** Grant platform or operator authority: roles, memberships and the invites that mint them. */
  'platform:role.grant',
  /** Manage billing, plans and entitlements. */
  'platform:billing.manage',
  /** Act as another user. */
  'platform:user.impersonate',
] as const

/**
 * Capabilities over user ACCOUNTS, as opposed to tenant data. Held by super_admin alone,
 * with the single deliberate exception of `identity:admin.invite`.
 *
 * WHY a separate family: the lifecycle surface is generic over its resource type and `user`
 * is one of those types, so `platform:tenant.purge` alone would let any platform admin
 * destroy any account. These permissions are the additional gate on the `user` resource,
 * and they are the ONLY thing separating the two administrative tiers — platform_admin
 * keeps every `platform:*` capability. Treat any change here as security-critical.
 */
export const IDENTITY_PERMISSIONS = [
  /** List, search and read any user account. */
  'identity:user.read',
  /** Archive, restore, tombstone or purge a user account. */
  'identity:user.lifecycle',
  /** Change a user's platform role. */
  'identity:role.assign',
  /**
   * Issue an invite that mints a platform administrator. Deliberately NOT super-admin-only:
   * recruiting a peer is a separate act from managing accounts, and platform admins hold
   * this one permission and nothing else from this family.
   */
  'identity:admin.invite',
] as const

export const ALL_PERMISSIONS = [...PLATFORM_PERMISSIONS, ...IDENTITY_PERMISSIONS] as const

export type PlatformPermission = (typeof ALL_PERMISSIONS)[number]

/**
 * Typed as a TOTAL Record so the compiler, not a reviewer, forces a mapping decision: a
 * value added to UserRole without an entry here fails to build. Silently resolving to no
 * permissions would be the dangerous failure in the other direction — a new role that
 * quietly loses access it was meant to have — and this makes it impossible.
 *
 * Introducing a read-only support role later is purely an edit to this object: no guard,
 * decorator or call site changes.
 */
export const ROLE_PLATFORM_PERMISSIONS: Record<UserRole, readonly PlatformPermission[]> = {
  guest: [],
  user: [],
  operator_staff: [],
  operator_admin: [],
  // Every tenant capability, plus the one identity capability that recruits a peer. A
  // platform admin can therefore create another platform admin but cannot list, read,
  // re-role or delete a single account — including the ones they invited.
  platform_admin: [...PLATFORM_PERMISSIONS, 'identity:admin.invite'],
  super_admin: ALL_PERMISSIONS,
}

/** Every UserRole, derived from the map above so the two can never drift apart. */
export const USER_ROLES = Object.keys(ROLE_PLATFORM_PERMISSIONS) as UserRole[]

/**
 * The administrative tier: roles that operate across every tenant rather than within one.
 *
 * Exists because `@Roles` lists and tenancy scoping key off the role itself, not off a
 * permission — `OperatorScopeService` has to answer "platform-wide or one operator?" before
 * any permission is consulted. Anywhere that previously compared against 'platform_admin'
 * to mean "not scoped to an operator" must use this instead, or a super admin resolves to
 * having no operator context and is refused on every operator-scoped route.
 */
export const PLATFORM_TIER_ROLES = ['platform_admin', 'super_admin'] as const

export type PlatformTierRole = (typeof PLATFORM_TIER_ROLES)[number]

export function isPlatformRole(role: UserRole): role is PlatformTierRole {
  return (PLATFORM_TIER_ROLES as readonly UserRole[]).includes(role)
}

export function hasPlatformPermission(role: UserRole, permission: PlatformPermission): boolean {
  // `role` arrives from a signature-verified JWT claim that is typed, not runtime-validated,
  // against the union. A token minted before a role was renamed must therefore fail closed
  // here rather than throw on an undefined lookup.
  return ROLE_PLATFORM_PERMISSIONS[role]?.includes(permission) ?? false
}

export interface AuthUser {
  id: string
  email: string
  role: UserRole
  emailVerified: boolean
  displayName?: string
  avatarUrl?: string
}

export interface AuthSession {
  accessToken: string
  refreshToken: string
  expiresAt: number
  user: AuthUser
}

export interface SignInCredentials {
  email: string
  password: string
}

export interface SignUpData {
  email: string
  password: string
  displayName?: string
  // Provider-level only, never client-supplied: the invite flows call signUp directly to
  // provision an operator admin, an operator staff member or a platform admin. Public HTTP
  // sign-up must pin this to 'user' at its own boundary — narrowing it here would break
  // invite acceptance, not harden it.
  //
  // 'super_admin' is deliberately ABSENT and must stay that way. No signup path may mint
  // that tier: it comes from the bootstrap CLI on an install that has none, or from
  // promotion by an existing super admin. Both require an authenticated actor who already
  // holds it, which a redeemed invite link by definition does not.
  role?: Extract<UserRole, 'user' | 'operator_staff' | 'operator_admin' | 'platform_admin'>
}

export interface AuthResult {
  session: AuthSession
}

export interface PasswordResetRequest {
  email: string
}

export interface TokenVerificationResult {
  user: AuthUser
  isExpired: boolean
  // Epoch SECONDS, straight from the JWT `iat` claim — the unit every issuer uses, and
  // what session revocation compares against. Not milliseconds like `expiresAt`.
  issuedAt: number
}
