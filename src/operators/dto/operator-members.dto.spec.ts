import {
  DEFAULT_STAFF_SCOPES,
  ORG_PERMISSIONS,
  STAFF_FORBIDDEN_SCOPES,
  isStaffGrantableScope,
} from '@spark/types'
import { setMemberScopesSchema } from './operator-members.dto'

describe('setMemberScopesSchema', () => {
  it('accepts the default staff set', () => {
    expect(setMemberScopesSchema.parse({ scopes: [...DEFAULT_STAFF_SCOPES] }).scopes).toEqual([
      ...DEFAULT_STAFF_SCOPES,
    ])
  })

  it('accepts an empty set — a staff member who may do nothing is expressible', () => {
    expect(setMemberScopesSchema.parse({ scopes: [] }).scopes).toEqual([])
  })

  // The boundary half of the structural exclusion. The service re-checks; the two must fail
  // independently, or removing either one silently opens billing to attendants.
  it('rejects org:billing.view outright', () => {
    expect(() => setMemberScopesSchema.parse({ scopes: ['org:billing.view'] })).toThrow()
    expect(() =>
      setMemberScopesSchema.parse({ scopes: ['org:booking.read', 'org:billing.view'] }),
    ).toThrow()
  })

  /**
   * The other four exclusions exist for a different reason than billing: every route they
   * gate is closed to OPERATOR_STAFF by its `@Roles` list, so granting one to a staff member
   * produced a persisted, displayed checkbox that conferred nothing at all.
   */
  it.each(['org:tariff.read', 'org:tariff.write', 'org:facility.write', 'org:member.manage'])(
    'rejects %s, which no staff-reachable route honours',
    (scope) => {
      expect(() => setMemberScopesSchema.parse({ scopes: [scope] })).toThrow()
    },
  )

  it('accepts every scope a staff member can actually exercise', () => {
    const grantable = ORG_PERMISSIONS.filter(isStaffGrantableScope)
    expect(setMemberScopesSchema.parse({ scopes: grantable }).scopes).toEqual(grantable)
    // Guards the pair against drifting apart: the schema and the predicate must agree on
    // exactly the same set.
    expect(grantable).toEqual(
      ORG_PERMISSIONS.filter((scope) => !STAFF_FORBIDDEN_SCOPES.includes(scope)),
    )
  })

  it('leaves the default staff set entirely grantable', () => {
    // A default that could not be re-submitted through this schema would make the scopes
    // editor unable to save a member it had just loaded.
    expect(DEFAULT_STAFF_SCOPES.every(isStaffGrantableScope)).toBe(true)
  })

  it('rejects a scope outside the closed set', () => {
    expect(() => setMemberScopesSchema.parse({ scopes: ['org:billing.manage'] })).toThrow()
  })
})
