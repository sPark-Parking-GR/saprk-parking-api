/**
 * What an operator plan grants, and what the API reports about the plan an operator is on.
 *
 * Shapes only. The zod schemas that PARSE these blobs stay in `apps/api` — this package
 * carries no runtime dependency, and validation belongs on the server that owns the write
 * boundary anyway. The two are kept honest by the API declaring its zod shape in terms of
 * `Entitlements`, so a field added on one side fails to compile on the other.
 */

/**
 * A closed set, not free-form strings. A feature flag that only ever exists as a typo in
 * one plan's JSON is indistinguishable from a feature nobody bought, and the failure is
 * silent in the direction that matters: the customer paid and the check returns false.
 *
 * Every member is wired to a real gate. A flag with no enforcement behind it sells nothing
 * and reads, to everyone downstream, exactly like one that does.
 */
export const SUBSCRIPTION_FEATURES = [
  /** Unlocks period-over-period comparison on the reporting surface. */
  'analytics.advanced',
  /** Marks the tenant for priority support routing. */
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

/** Mirrors the Prisma enums of the same names; string unions so this package stays typeless. */
export type SubscriptionStatus = 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'CANCELLED'
export type BillingInterval = 'MONTHLY' | 'YEARLY'
export type SubscriptionLifecycleStatus = 'ACTIVE' | 'ARCHIVED' | 'TOMBSTONED' | 'PURGED'

/**
 * `null` is unlimited; `0` is a real limit that permits nothing. They are deliberately
 * distinguishable, because "we did not cap this" and "this plan grants none of these" are
 * different products and collapsing them would make one unexpressible.
 *
 * A type alias rather than an interface: this shape is written straight into a Prisma `Json`
 * column, and only an alias carries the implicit index signature that assignment needs.
 */
export type Entitlements = {
  maxFacilities: number | null
  maxTariffPlans: number | null
  maxStaffSeats: number | null
  features: SubscriptionFeature[]
  /** The platform's take on a booking, in basis points of the stay total. */
  commissionBps: number
}

/**
 * A negotiated deviation states only the keys that differ, so "Starter, but four
 * facilities" does not require a bespoke plan in the public catalog. Partial rather than a
 * full second entitlement set on purpose: an override that restated every key would freeze
 * the plan's other terms at the moment the deal was struck and silently opt the tenant out
 * of later catalog corrections.
 */
export type EntitlementOverride = Partial<Entitlements>

/** Where the entitlements in force came from, so a surface can explain them. */
export type EntitlementSource = 'exempt' | 'subscription' | 'subscription+override' | 'default'

export interface OperatorUsage {
  facilities: number
  tariffPlans: number
  staffSeats: number
}

export interface EffectiveEntitlements {
  operatorId: string
  entitlements: Entitlements
  source: EntitlementSource
  planCode: string | null
  planName: string | null
  subscriptionId: string | null
  status: SubscriptionStatus | null
}

export interface PlanView {
  id: string
  code: string
  name: string
  description: string | null
  priceCents: number
  currency: string
  interval: BillingInterval
  entitlements: Entitlements
  isPublic: boolean
  sortOrder: number
  lifecycleStatus: SubscriptionLifecycleStatus
  subscribers: number
}

export interface OperatorSubscriptionView extends EffectiveEntitlements {
  usage: OperatorUsage
  planId: string | null
  currentPeriodStart: Date | null
  currentPeriodEnd: Date | null
  trialEndsAt: Date | null
  cancelAtPeriodEnd: boolean
  providerSubscriptionId: string | null
  entitlementOverride: EntitlementOverride | null
}

/**
 * The single fact a support-routing integration needs about an operator. Deliberately not a
 * support system: it says which queue the tenant belongs in and nothing else.
 */
export interface OperatorSupportTier {
  operatorId: string
  priority: boolean
}
