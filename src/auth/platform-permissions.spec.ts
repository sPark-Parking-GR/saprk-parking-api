import {
  ALL_PERMISSIONS,
  IDENTITY_PERMISSIONS,
  PLATFORM_PERMISSIONS,
  ROLE_PLATFORM_PERMISSIONS,
  USER_ROLES,
  hasPlatformPermission,
  isPlatformRole,
  type PlatformPermission,
  type UserRole,
} from '@spark/types'

// Restated rather than imported so that adding a value to UserRole cannot pass silently:
// the compiler already forces an entry in ROLE_PLATFORM_PERMISSIONS (it is a total Record),
// and this makes the grant that entry expresses a conscious, reviewed decision too.
const DECLARED_ROLES: UserRole[] = [
  'guest',
  'user',
  'operator_staff',
  'operator_admin',
  'platform_admin',
  'super_admin',
]

const DECLARED_PLATFORM_PERMISSIONS: PlatformPermission[] = [
  'platform:tenant.read',
  'platform:tenant.write',
  'platform:tenant.purge',
  'platform:role.grant',
  'platform:billing.manage',
  'platform:user.impersonate',
]

const DECLARED_IDENTITY_PERMISSIONS: PlatformPermission[] = [
  'identity:user.read',
  'identity:user.lifecycle',
  'identity:role.assign',
  'identity:admin.invite',
]

/** The whole point of the tier split: these are super_admin's and nobody else's. */
const SUPER_ADMIN_ONLY: PlatformPermission[] = [
  'identity:user.read',
  'identity:user.lifecycle',
  'identity:role.assign',
]

const UNPRIVILEGED_ROLES = DECLARED_ROLES.filter((role) => !isPlatformRole(role))

describe('platform permission contract', () => {
  it('declares exactly the capabilities web and mobile are promised', () => {
    expect([...PLATFORM_PERMISSIONS].sort()).toEqual([...DECLARED_PLATFORM_PERMISSIONS].sort())
    expect([...IDENTITY_PERMISSIONS].sort()).toEqual([...DECLARED_IDENTITY_PERMISSIONS].sort())
    expect([...ALL_PERMISSIONS].sort()).toEqual(
      [...DECLARED_PLATFORM_PERMISSIONS, ...DECLARED_IDENTITY_PERMISSIONS].sort(),
    )
  })

  it('maps exactly the roles the contract declares, and no others', () => {
    expect([...USER_ROLES].sort()).toEqual([...DECLARED_ROLES].sort())
    expect(Object.keys(ROLE_PLATFORM_PERMISSIONS).sort()).toEqual([...DECLARED_ROLES].sort())
  })

  it('gives super_admin every permission there is', () => {
    for (const permission of ALL_PERMISSIONS) {
      expect(hasPlatformPermission('super_admin', permission)).toBe(true)
    }
  })

  it('gives platform_admin every tenant capability', () => {
    for (const permission of PLATFORM_PERMISSIONS) {
      expect(hasPlatformPermission('platform_admin', permission)).toBe(true)
    }
  })

  // The entire boundary between the two administrative tiers, asserted directly.
  it.each(SUPER_ADMIN_ONLY)('withholds %s from platform_admin', (permission) => {
    expect(hasPlatformPermission('platform_admin', permission)).toBe(false)
    expect(hasPlatformPermission('super_admin', permission)).toBe(true)
  })

  // The one deliberate exception: recruiting a peer is not account management.
  it('lets platform_admin invite a peer administrator', () => {
    expect(hasPlatformPermission('platform_admin', 'identity:admin.invite')).toBe(true)
  })

  it.each(UNPRIVILEGED_ROLES)('gives %s no permission at all', (role) => {
    expect(ROLE_PLATFORM_PERMISSIONS[role]).toEqual([])
    for (const permission of ALL_PERMISSIONS) {
      expect(hasPlatformPermission(role, permission)).toBe(false)
    }
  })

  it('treats exactly the administrative roles as platform-tier', () => {
    expect(DECLARED_ROLES.filter(isPlatformRole)).toEqual(['platform_admin', 'super_admin'])
  })

  it('fails closed for a role outside the union', () => {
    const stale = 'support_readonly' as UserRole

    expect(hasPlatformPermission(stale, 'platform:tenant.read')).toBe(false)
    expect(isPlatformRole(stale)).toBe(false)
  })
})
