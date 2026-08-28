import { DEFAULT_STAFF_SCOPES, ORG_PERMISSIONS } from '@spark/types'
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

  it('accepts every other org permission', () => {
    const grantable = ORG_PERMISSIONS.filter((scope) => scope !== 'org:billing.view')
    expect(setMemberScopesSchema.parse({ scopes: grantable }).scopes).toEqual(grantable)
  })

  it('rejects a scope outside the closed set', () => {
    expect(() => setMemberScopesSchema.parse({ scopes: ['org:billing.manage'] })).toThrow()
  })
})
