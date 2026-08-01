import {
  PLATFORM_PERMISSIONS,
  ROLE_PLATFORM_PERMISSIONS,
  USER_ROLES,
  hasPlatformPermission,
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
]

const DECLARED_PERMISSIONS: PlatformPermission[] = [
  'platform:tenant.read',
  'platform:tenant.write',
  'platform:tenant.purge',
  'platform:role.grant',
  'platform:billing.manage',
  'platform:user.impersonate',
]

describe('platform permission contract', () => {
  it('declares exactly the capabilities web and mobile are promised', () => {
    expect([...PLATFORM_PERMISSIONS].sort()).toEqual([...DECLARED_PERMISSIONS].sort())
  })

  it('maps exactly the roles the contract declares, and no others', () => {
    expect([...USER_ROLES].sort()).toEqual([...DECLARED_ROLES].sort())
    expect(Object.keys(ROLE_PLATFORM_PERMISSIONS).sort()).toEqual([...DECLARED_ROLES].sort())
  })

  it('gives platform_admin every permission', () => {
    for (const permission of PLATFORM_PERMISSIONS) {
      expect(hasPlatformPermission('platform_admin', permission)).toBe(true)
    }
  })

  it.each(DECLARED_ROLES.filter((role) => role !== 'platform_admin'))(
    'gives %s no platform permission at all',
    (role) => {
      expect(ROLE_PLATFORM_PERMISSIONS[role]).toEqual([])
      for (const permission of PLATFORM_PERMISSIONS) {
        expect(hasPlatformPermission(role, permission)).toBe(false)
      }
    },
  )

  it('fails closed for a role outside the union', () => {
    const stale = 'support_readonly' as UserRole

    expect(hasPlatformPermission(stale, 'platform:tenant.read')).toBe(false)
  })
})
