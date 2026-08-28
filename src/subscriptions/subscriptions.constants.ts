import { SubscriptionStatus } from '@prisma/client'
import type { Entitlements } from '@spark/types'

/**
 * The plan an operator resolves to when it holds no live subscription. Every operator
 * predating billing was backfilled onto it by 20260803100000_subscription_entitlements,
 * and the onboarding flow mints PENDING shell operators that no billing code has touched
 * yet — both must land somewhere deterministic rather than unlimited.
 */
export const DEFAULT_PLAN_CODE = 'starter'

/**
 * CANCELLED is terminal; the rest are live. Matches the partial unique index
 * OperatorSubscription_operator_live_key exactly, so at most one row is ever selected.
 * PAST_DUE is deliberately live: a failed charge starts dunning, it does not instantly
 * revoke a paying tenant's limits mid-cycle.
 */
export const LIVE_SUBSCRIPTION_STATUSES = [
  SubscriptionStatus.TRIALING,
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.PAST_DUE,
] as const

/**
 * What the synthetic ingestion operator gets. Not a plan and not sold — see
 * EntitlementService.isQuotaExempt for why that operator is outside billing entirely.
 */
export const UNLIMITED_ENTITLEMENTS: Entitlements = {
  maxFacilities: null,
  maxTariffPlans: null,
  maxStaffSeats: null,
  features: [],
  commissionBps: 0,
}
