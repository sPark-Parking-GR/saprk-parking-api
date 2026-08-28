import { z } from 'zod'

/**
 * A closed set, not free-form strings, for the same reason the operator side is closed: a
 * feature that only ever exists as a typo in one plan's JSON is indistinguishable from a
 * feature nobody bought, and the failure is silent in the direction that matters — the
 * rider paid and the check returns false.
 *
 * Deliberately one member. This is scaffolding for a catalog product has not yet
 * finalised; every extra code here is a promise the booking flow does not keep.
 */
export const DRIVER_SUBSCRIPTION_FEATURES = ['support.priority'] as const

export type DriverSubscriptionFeature = (typeof DRIVER_SUBSCRIPTION_FEATURES)[number]

/**
 * The contract for what a driver plan grants. `.strict()` is load-bearing exactly as it is
 * on the operator schema: every crossing of this boundary — catalog write, catalog read,
 * override write, effective resolution — parses through here, so a blob that predates a
 * schema change fails loudly at read time rather than granting whatever `undefined` means
 * at the comparison site.
 *
 * `null` is "no such perk", not "unlimited": a plan with no free cancellations and a plan
 * with a cap of zero are the same product, unlike an operator quota where the distinction
 * is real. The nullable form exists so a perk can be absent from a plan rather than
 * present-and-worthless.
 */
export const driverEntitlementsSchema = z
  .object({
    bookingDiscountBps: z.number().int().min(0).max(10_000).nullable(),
    bookingFeeWaived: z.boolean(),
    freeCancellations: z.number().int().min(0).max(1_000_000).nullable(),
    features: z.array(z.enum(DRIVER_SUBSCRIPTION_FEATURES)),
  })
  .strict()

export type DriverEntitlements = z.infer<typeof driverEntitlementsSchema>

/**
 * A negotiated deviation states only the keys that differ. Partial rather than a full
 * second entitlement set on purpose: an override restating every key would freeze the
 * plan's other terms at the moment the deal was struck and silently opt the rider out of
 * later catalog corrections.
 */
export const driverEntitlementOverrideSchema = driverEntitlementsSchema.partial()

export type DriverEntitlementOverride = z.infer<typeof driverEntitlementOverrideSchema>

/**
 * What a rider holding no live DriverSubscription resolves to. Unlike the operator side —
 * where the absence of a subscription means "look up the default plan" and a missing
 * catalog row fails closed — the free tier is a real, complete answer that needs no
 * database row, which is why no DriverSubscription is backfilled for existing users.
 */
export const FREE_TIER_DRIVER_ENTITLEMENTS: DriverEntitlements = {
  bookingDiscountBps: null,
  bookingFeeWaived: false,
  freeCancellations: null,
  features: [],
}

/** Deduplicated and ordered so two equivalent feature sets are byte-identical in storage. */
export function normalizeDriverEntitlements(
  entitlements: DriverEntitlements,
): DriverEntitlements {
  return { ...entitlements, features: [...new Set(entitlements.features)].sort() }
}

/**
 * Shallow by design: every key is a scalar or a whole-value replacement, so a deep merge
 * would only create a way for an override to half-apply. An override naming `features`
 * replaces the plan's list outright rather than unioning with it — a deal that removes a
 * perk has to be expressible, and a union could never do that.
 */
export function mergeDriverEntitlements(
  base: DriverEntitlements,
  override: DriverEntitlementOverride,
): DriverEntitlements {
  return normalizeDriverEntitlements(driverEntitlementsSchema.parse({ ...base, ...override }))
}

export function hasDriverFeature(
  entitlements: DriverEntitlements,
  feature: DriverSubscriptionFeature,
): boolean {
  return entitlements.features.includes(feature)
}
