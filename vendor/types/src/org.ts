/**
 * What a member may do INSIDE one operator, as opposed to across the platform.
 *
 * Deliberately a separate namespace from PlatformPermission rather than more entries in it.
 * The two answer different questions — "may this caller act on any tenant" versus "may this
 * member do this within the tenant they belong to" — and a single union would make it
 * possible to write an org scope where a platform permission is checked, or the reverse,
 * with the type system raising nothing.
 *
 * The prefix is `org:` for the same reason: a scope and a permission are never
 * interchangeable, and the string should say so at every call site and in every audit row.
 */
export const ORG_PERMISSIONS = [
  /** See facilities belonging to this operator. */
  'org:facility.read',
  /** Create, edit and publish this operator's facilities. */
  'org:facility.write',
  /** See this operator's tariff plans. */
  'org:tariff.read',
  /** Create and edit this operator's tariff plans and their rates. */
  'org:tariff.write',
  /** See bookings taken at this operator's facilities. */
  'org:booking.read',
  /** Cancel, refund or otherwise act on those bookings. */
  'org:booking.write',
  /** Scan and verify tickets at the barrier. */
  'org:scan.execute',
  /** See occupancy, revenue and other reporting for this operator. */
  'org:stats.read',
  /** Invite, re-scope and remove this operator's members. */
  'org:member.manage',
  /** See the plan, seat usage and invoices. Never write — billing is changed by sPark. */
  'org:billing.view',
] as const

export type OrgPermission = (typeof ORG_PERMISSIONS)[number]

/**
 * What a member with no explicit scopes gets. Chosen to match exactly what an
 * OPERATOR_STAFF account could already reach before scopes existed, so introducing them
 * neither grants nor removes anything from anybody already in the system.
 */
export const DEFAULT_STAFF_SCOPES: readonly OrgPermission[] = [
  'org:facility.read',
  'org:booking.read',
  'org:scan.execute',
  'org:stats.read',
]

/**
 * Scopes a STAFF membership may never hold, however the row was written.
 *
 * Billing is the operator's own money: which plan they bought, what it costs, what they
 * still owe. Keeping an attendant out of it by convention alone means one mis-set checkbox
 * — or one row written by a script, a fixture or a future import — silently exposes it, so
 * the exclusion is enforced structurally instead: rejected at every write, and filtered out
 * again at read so a legacy row that already carries it grants nothing.
 *
 * The rest are here for a different reason: every route they gate is closed to
 * OPERATOR_STAFF by its `@Roles` list, so RolesGuard refuses before scopes are consulted.
 * They were offered as checkboxes in the team screen regardless, which meant an operator
 * admin could tick a box, watch it persist, and grant nothing whatsoever. Listing them
 * makes the permission UI describe what it can actually do. Admitting staff to any of those
 * routes is a deliberate product decision; the day it is taken, remove the scope from here
 * and the checkbox comes back with real effect behind it.
 *
 * ADMIN is unaffected. Their set is DERIVED from ORG_PERMISSIONS, so an operator's owner
 * keeps billing visibility, tariff editing and member management exactly as before.
 */
export const STAFF_FORBIDDEN_SCOPES: readonly OrgPermission[] = [
  'org:billing.view',
  'org:tariff.read',
  'org:tariff.write',
  'org:facility.write',
  'org:member.manage',
]

/**
 * An operator's own administrator holds everything within their operator, always.
 *
 * DERIVED rather than stored: writing the full set onto every ADMIN membership would freeze
 * it at the moment the row was created, so a scope added later would silently not apply to
 * existing admins — the failure mode being an owner locked out of a feature of their own
 * business.
 */
export function scopesFor(
  memberRole: 'ADMIN' | 'STAFF',
  stored: readonly string[],
): readonly OrgPermission[] {
  if (memberRole === 'ADMIN') return ORG_PERMISSIONS
  return stored.filter(isStaffGrantableScope)
}

export function isOrgPermission(value: string): value is OrgPermission {
  return (ORG_PERMISSIONS as readonly string[]).includes(value)
}

/** An org permission that a STAFF membership is allowed to be granted. */
export function isStaffGrantableScope(value: string): value is OrgPermission {
  return isOrgPermission(value) && !STAFF_FORBIDDEN_SCOPES.includes(value)
}

/**
 * Fails closed on an unrecognised scope, matching hasPlatformPermission: a row written by a
 * newer build, or one whose scope was renamed, must deny rather than throw or admit.
 */
export function hasOrgPermission(granted: readonly string[], permission: OrgPermission): boolean {
  return granted.includes(permission)
}
