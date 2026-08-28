import {
  driverEntitlementOverrideSchema,
  driverEntitlementsSchema,
  hasDriverFeature,
  mergeDriverEntitlements,
  normalizeDriverEntitlements,
  FREE_TIER_DRIVER_ENTITLEMENTS,
  type DriverEntitlements,
} from './driver-entitlements.schema'

const base: DriverEntitlements = {
  bookingDiscountBps: 1_000,
  bookingFeeWaived: false,
  freeCancellations: 2,
  features: [],
}

describe('driverEntitlementsSchema', () => {
  it('accepts a full driver plan shape', () => {
    expect(driverEntitlementsSchema.parse(base)).toEqual(base)
  })

  it('accepts the free-tier constant it is the fallback for', () => {
    expect(driverEntitlementsSchema.parse(FREE_TIER_DRIVER_ENTITLEMENTS)).toEqual(
      FREE_TIER_DRIVER_ENTITLEMENTS,
    )
  })

  // The whole reason the blob is validated: an unknown key is a typo or a field from a
  // schema that has moved on, and either one silently changes what a rider paid for.
  it('rejects unknown keys rather than ignoring them', () => {
    expect(() => driverEntitlementsSchema.parse({ ...base, bookingDiscount: 10 })).toThrow()
  })

  it('rejects a missing key rather than defaulting it', () => {
    const incomplete: Record<string, unknown> = { ...base }
    delete incomplete['bookingFeeWaived']
    expect(() => driverEntitlementsSchema.parse(incomplete)).toThrow()
  })

  it('rejects a discount outside 0..10000 basis points', () => {
    expect(() => driverEntitlementsSchema.parse({ ...base, bookingDiscountBps: 10_001 })).toThrow()
    expect(() => driverEntitlementsSchema.parse({ ...base, bookingDiscountBps: -1 })).toThrow()
    expect(
      driverEntitlementsSchema.parse({ ...base, bookingDiscountBps: 10_000 }).bookingDiscountBps,
    ).toBe(10_000)
  })

  it('rejects a fractional discount or cancellation count', () => {
    expect(() => driverEntitlementsSchema.parse({ ...base, bookingDiscountBps: 12.5 })).toThrow()
    expect(() => driverEntitlementsSchema.parse({ ...base, freeCancellations: 1.5 })).toThrow()
  })

  it('accepts null for a perk the plan does not carry at all', () => {
    expect(
      driverEntitlementsSchema.parse({ ...base, freeCancellations: null }).freeCancellations,
    ).toBeNull()
  })

  it('rejects a feature code outside the closed set', () => {
    expect(() => driverEntitlementsSchema.parse({ ...base, features: ['support.priorty'] })).toThrow()
    expect(() =>
      driverEntitlementsSchema.parse({ ...base, features: ['analytics.advanced'] }),
    ).toThrow()
  })

  it('rejects a non-boolean fee waiver rather than coercing it', () => {
    expect(() => driverEntitlementsSchema.parse({ ...base, bookingFeeWaived: 'yes' })).toThrow()
  })
})

describe('driverEntitlementOverrideSchema', () => {
  it('accepts a single-key negotiated deviation', () => {
    expect(driverEntitlementOverrideSchema.parse({ bookingDiscountBps: 2_500 })).toEqual({
      bookingDiscountBps: 2_500,
    })
  })

  it('accepts an empty override', () => {
    expect(driverEntitlementOverrideSchema.parse({})).toEqual({})
  })

  it('still rejects unknown keys', () => {
    expect(() => driverEntitlementOverrideSchema.parse({ bookingDiscount: 10 })).toThrow()
  })

  it('still rejects a valid key with an invalid value', () => {
    expect(() => driverEntitlementOverrideSchema.parse({ bookingDiscountBps: -2 })).toThrow()
  })
})

describe('mergeDriverEntitlements', () => {
  it('lets the override win over the plan', () => {
    expect(mergeDriverEntitlements(base, { bookingDiscountBps: 2_500 }).bookingDiscountBps).toBe(
      2_500,
    )
  })

  it('leaves keys the override does not name alone', () => {
    const merged = mergeDriverEntitlements(base, { bookingDiscountBps: 2_500 })
    expect(merged.freeCancellations).toBe(2)
    expect(merged.bookingFeeWaived).toBe(false)
  })

  it('lets an override remove a perk outright', () => {
    expect(mergeDriverEntitlements(base, { bookingDiscountBps: null }).bookingDiscountBps).toBeNull()
  })

  // Replacement, not union: a deal that REMOVES a feature has to be expressible.
  it('replaces the feature list outright instead of unioning it', () => {
    const withFeatures = { ...base, features: ['support.priority' as const] }
    expect(mergeDriverEntitlements(withFeatures, { features: [] }).features).toEqual([])
  })

  it('produces a value that still satisfies the full schema', () => {
    expect(() =>
      driverEntitlementsSchema.parse(mergeDriverEntitlements(base, { bookingFeeWaived: true })),
    ).not.toThrow()
  })
})

describe('normalizeDriverEntitlements', () => {
  it('deduplicates and orders features so equal sets store identically', () => {
    const a = normalizeDriverEntitlements({
      ...base,
      features: ['support.priority', 'support.priority'],
    })
    const b = normalizeDriverEntitlements({ ...base, features: ['support.priority'] })
    expect(a.features).toEqual(['support.priority'])
    expect(a).toEqual(b)
  })
})

describe('hasDriverFeature', () => {
  it('reports membership of the granted set', () => {
    const granted = { ...base, features: ['support.priority' as const] }
    expect(hasDriverFeature(granted, 'support.priority')).toBe(true)
    expect(hasDriverFeature(FREE_TIER_DRIVER_ENTITLEMENTS, 'support.priority')).toBe(false)
  })
})

describe('FREE_TIER_DRIVER_ENTITLEMENTS', () => {
  // The no-row fallback grants nothing, which is the point: a rider who has not paid must
  // never resolve to a perk, and there is no catalog row to consult that could say otherwise.
  it('grants no perk at all', () => {
    expect(FREE_TIER_DRIVER_ENTITLEMENTS).toEqual({
      bookingDiscountBps: null,
      bookingFeeWaived: false,
      freeCancellations: null,
      features: [],
    })
  })
})
