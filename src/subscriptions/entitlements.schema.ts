import { z } from 'zod'

/**
 * A closed set, not free-form strings. A feature flag that only ever exists as a typo in
 * one plan's JSON is indistinguishable from a feature nobody bought, and the failure is
 * silent in the direction that matters: the customer paid and the check returns false.
 */
export const SUBSCRIPTION_FEATURES = [
  'analytics.advanced',
  'api.access',
  'branding.custom',
  'support.priority',
  /**
   * Unlocks the team surface: inviting staff, and setting what each of them may do.
   *
   * Separate from maxStaffSeats because they answer different questions. The feature is
   * whether the operator bought team management at all; the seat count is how many people
   * it covers. Collapsing them into "seats > 0" would make a plan that sells the capability
   * with no seats yet unexpressible, and would put the reason for a refusal — unbought
   * versus outgrown — beyond the API's ability to say.
   */
  'team.management',
] as const

export type SubscriptionFeature = (typeof SUBSCRIPTION_FEATURES)[number]

/**
 * `null` is unlimited; `0` is a real limit that permits nothing. They are deliberately
 * distinguishable, because "we did not cap this" and "this plan grants none of these" are
 * different products and collapsing them would make one unexpressible.
 */
const limitSchema = z.number().int().min(0).max(1_000_000).nullable()

/**
 * The contract for what a plan grants. `.strict()` is load-bearing: an unknown key is a
 * typo or a stale field from a schema that has moved on, and accepting it silently is how
 * a JSON blob drifts away from the code that reads it. Every crossing of this boundary —
 * catalog write, catalog read, override write, effective resolution — parses through here,
 * so a blob that predates a schema change fails loudly at read time rather than granting
 * whatever `undefined` happens to mean at the comparison site.
 */
export const entitlementsSchema = z
  .object({
    maxFacilities: limitSchema,
    maxTariffPlans: limitSchema,
    maxStaffSeats: limitSchema,
    features: z.array(z.enum(SUBSCRIPTION_FEATURES)),
    commissionBps: z.number().int().min(0).max(10_000),
  })
  .strict()

export type Entitlements = z.infer<typeof entitlementsSchema>

/**
 * A negotiated deviation states only the keys that differ, so "Starter, but four
 * facilities" does not require a bespoke plan in the public catalog. Partial rather than a
 * full second entitlement set on purpose: an override that restated every key would freeze
 * the plan's other terms at the moment the deal was struck and silently opt the tenant out
 * of later catalog corrections.
 */
export const entitlementOverrideSchema = entitlementsSchema.partial()

export type EntitlementOverride = z.infer<typeof entitlementOverrideSchema>

export const QUOTA_KEYS = ['maxFacilities', 'maxTariffPlans', 'maxStaffSeats'] as const

export type QuotaKey = (typeof QUOTA_KEYS)[number]

/** Deduplicated and ordered so two equivalent feature sets are byte-identical in storage. */
export function normalizeEntitlements(entitlements: Entitlements): Entitlements {
  return { ...entitlements, features: [...new Set(entitlements.features)].sort() }
}

/**
 * Shallow by design: every entitlement key is a scalar or a whole-value replacement, so a
 * deep merge would only create a way for an override to half-apply. An override that names
 * `features` replaces the plan's list outright rather than unioning with it — a deal that
 * removes a feature has to be expressible, and a union could never do that.
 */
export function mergeEntitlements(base: Entitlements, override: EntitlementOverride): Entitlements {
  return normalizeEntitlements(entitlementsSchema.parse({ ...base, ...override }))
}

export function hasFeature(entitlements: Entitlements, feature: SubscriptionFeature): boolean {
  return entitlements.features.includes(feature)
}
