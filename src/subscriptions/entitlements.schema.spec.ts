import { SUBSCRIPTION_FEATURES, type Entitlements } from '@spark/types'
import {
  entitlementOverrideSchema,
  entitlementsSchema,
  hasFeature,
  mergeEntitlements,
  normalizeEntitlements,
} from './entitlements.schema'

const base: Entitlements = {
  maxFacilities: 1,
  maxTariffPlans: null,
  maxStaffSeats: 5,
  features: [],
  commissionBps: 0,
}

describe('entitlementsSchema', () => {
  it('accepts the Starter shape the migration seeds', () => {
    expect(entitlementsSchema.parse(base)).toEqual(base)
  })

  it('distinguishes null (unlimited) from 0 (nothing granted)', () => {
    expect(entitlementsSchema.parse({ ...base, maxFacilities: null }).maxFacilities).toBeNull()
    expect(entitlementsSchema.parse({ ...base, maxFacilities: 0 }).maxFacilities).toBe(0)
  })

  // The whole reason the blob is validated: an unknown key is a typo or a field from a
  // schema that has moved on, and either one silently changes what a customer may do.
  it('rejects unknown keys rather than ignoring them', () => {
    expect(() => entitlementsSchema.parse({ ...base, maxFacilties: 9 })).toThrow()
  })

  it('rejects a missing key rather than defaulting it', () => {
    const incomplete: Record<string, unknown> = { ...base }
    delete incomplete['maxStaffSeats']
    expect(() => entitlementsSchema.parse(incomplete)).toThrow()
  })

  it('rejects a fractional or negative limit', () => {
    expect(() => entitlementsSchema.parse({ ...base, maxFacilities: 1.5 })).toThrow()
    expect(() => entitlementsSchema.parse({ ...base, maxFacilities: -1 })).toThrow()
  })

  it('rejects a commission outside 0..10000 basis points', () => {
    expect(() => entitlementsSchema.parse({ ...base, commissionBps: 10_001 })).toThrow()
    expect(entitlementsSchema.parse({ ...base, commissionBps: 10_000 }).commissionBps).toBe(10_000)
  })

  it('rejects a feature code outside the closed set', () => {
    expect(() => entitlementsSchema.parse({ ...base, features: ['analytics.advnaced'] })).toThrow()
  })
})

describe('entitlementOverrideSchema', () => {
  it('accepts a single-key negotiated deviation', () => {
    expect(entitlementOverrideSchema.parse({ maxFacilities: 4 })).toEqual({ maxFacilities: 4 })
  })

  it('accepts an empty override', () => {
    expect(entitlementOverrideSchema.parse({})).toEqual({})
  })

  it('still rejects unknown keys', () => {
    expect(() => entitlementOverrideSchema.parse({ maxSites: 4 })).toThrow()
  })

  it('still rejects a valid key with an invalid value', () => {
    expect(() => entitlementOverrideSchema.parse({ maxFacilities: -2 })).toThrow()
  })
})

describe('mergeEntitlements', () => {
  it('lets the override win over the plan', () => {
    expect(mergeEntitlements(base, { maxFacilities: 4 }).maxFacilities).toBe(4)
  })

  it('leaves keys the override does not name alone', () => {
    const merged = mergeEntitlements(base, { maxFacilities: 4 })
    expect(merged.maxStaffSeats).toBe(5)
    expect(merged.maxTariffPlans).toBeNull()
  })

  it('lets an override raise a limit to unlimited', () => {
    expect(mergeEntitlements(base, { maxFacilities: null }).maxFacilities).toBeNull()
  })

  // Replacement, not union: a deal that REMOVES a feature has to be expressible.
  it('replaces the feature list outright instead of unioning it', () => {
    const withFeatures = { ...base, features: ['team.management' as const] }
    expect(mergeEntitlements(withFeatures, { features: [] }).features).toEqual([])
  })

  it('produces a value that still satisfies the full schema', () => {
    expect(() =>
      entitlementsSchema.parse(mergeEntitlements(base, { maxStaffSeats: 2 })),
    ).not.toThrow()
  })
})

describe('normalizeEntitlements', () => {
  it('deduplicates and orders features so equal sets store identically', () => {
    const a = normalizeEntitlements({
      ...base,
      features: ['team.management', 'analytics.advanced', 'team.management'],
    })
    const b = normalizeEntitlements({ ...base, features: ['analytics.advanced', 'team.management'] })
    expect(a.features).toEqual(['analytics.advanced', 'team.management'])
    expect(a).toEqual(b)
  })
})

describe('hasFeature', () => {
  it('reports membership of the granted set', () => {
    const granted = { ...base, features: ['team.management' as const] }
    expect(hasFeature(granted, 'team.management')).toBe(true)
    expect(hasFeature(granted, 'analytics.advanced')).toBe(false)
  })

  // Every member of the closed set is wired to a gate; a flag with nothing behind it reads
  // to a customer exactly like one that works, which is the failure this set exists to stop.
  it('carries no feature the API does not enforce', () => {
    expect([...SUBSCRIPTION_FEATURES].sort()).toEqual([
      'analytics.advanced',
      'support.priority',
      'team.management',
    ])
  })
})
