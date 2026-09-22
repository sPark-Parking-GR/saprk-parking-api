import type { CapScope, LifecycleStatus, RateUnit, VehicleType } from '@prisma/client'

export interface QuoteRequest {
  facilityId: string
  startsAt: Date
  endsAt: Date
  vehicleType: VehicleType
  /**
   * Whose subscription perks apply. Optional because the public `GET /facilities/:id/quote`
   * preview is unauthenticated and stays that way: it prices a stay, not a person's stay.
   * Personalisation happens where a rider is actually known — booking creation.
   */
  userId?: string
}

export interface QuoteLineItem {
  label: string
  durationMinutes: number
  unitPriceCents: number
  quantity: number
  subtotalCents: number
}

export interface PriceQuote {
  facilityId: string
  startsAt: Date
  endsAt: Date
  durationMinutes: number
  vehicleType: VehicleType
  lineItems: QuoteLineItem[]
  totalCents: number
  /** Already deducted from totalCents; carried so a client can show the perk it represents. */
  discountCents: number
  currency: string
  expiresAt: Date
  planId: string
  planVersion: number
}

export interface PinnedPriceRequest {
  planId: string
  planVersion: number
  startsAt: Date
  endsAt: Date
  /**
   * The booking's own owner. Required in practice at check-out even though it is optional
   * here: repricing the real stay without the rider's discount would bill a subscriber the
   * full amount after quoting them a reduced one.
   */
  userId?: string
}

export interface PinnedPriceResult {
  totalCents: number
  discountCents: number
  currency: string
  billableMinutes: number
  commissionCents: number
}

export const QUOTE_TTL_MINUTES = 10
export const BOOKING_HOLD_MINUTES = 10

// Well under pricing-engine's 366-day MAX_BILLABLE_MINUTES cap: a booking limit needs
// its own, tighter ceiling so a single hold can't pin inventory for near a year while
// still covering legitimate long-stay (e.g. monthly) parking.
export const MAX_BOOKING_DURATION_MINUTES = 30 * 24 * 60
// Absorbs clock skew and slow checkout flows without allowing meaningfully backdated
// bookings (which would create un-honourable history).
export const BOOKING_BACKDATE_GRACE_MINUTES = 5

export interface CompiledTier {
  id: string
  fromMinute: number
  toMinute: number | null
  unit: RateUnit
  blockMinutes: number | null
}

export interface CompiledWindow {
  id: string
  label: string
  dayMask: number
  startMinute: number
  endMinute: number
}

export interface CompiledCap {
  windowMinutes: number
  capCents: number
  scope: CapScope
}

export interface CompiledPlan {
  id: string
  version: number
  timezone: string
  graceMinutes: number
  incrementMinutes: number
  currency: string
  tiers: CompiledTier[]
  windows: CompiledWindow[]
  caps: CompiledCap[]
  price: (tierId: string, windowId: string) => number | undefined
}

export interface PriceResult {
  lineItems: QuoteLineItem[]
  totalCents: number
  billableMinutes: number
  /**
   * What a subscribed rider's plan took off, already subtracted from totalCents and already
   * present as its own negative line item. Zero for everyone else.
   */
  discountCents: number
  /** The take-rate that produced commissionCents, carried so a figure can be explained. */
  commissionBps: number
  /**
   * The platform's cut of totalCents. NOT a line item and never added to what the driver
   * pays: the stay costs the same whatever the operator's plan charges the operator.
   */
  commissionCents: number
}

export interface TariffPlanListItem {
  id: string
  operatorId: string
  operatorName: string
  name: string
  isActive: boolean
  isDefault: boolean
  lifecycleStatus: LifecycleStatus
  validFrom: Date | null
  validTo: Date | null
  vehicleTypes: string[]
  version: number
  updatedAt: Date
}

export interface PlanAssignment {
  id: string
  name: string
}

export interface PlanAssignments {
  facilities: PlanAssignment[]
  count: number
  isDefault: boolean
  implicitFacilityCount: number
}

export interface TariffDraftTier {
  key: string
  fromMinute: number
  toMinute: number | null
  unit: string
  blockMinutes: number | null
}

export interface TariffDraftWindow {
  key: string
  label: string
  dayMask: number
  startMinute: number
  endMinute: number
}

export interface TariffDraftRate {
  tierKey: string
  windowKey: string
  priceCents: number
  currency: string
}

export interface TariffDraftCap {
  windowMinutes: number
  capCents: number
  scope: string
}

export interface TariffPlanDetail {
  id: string
  name: string
  isActive: boolean
  isDefault: boolean
  validFrom: Date | null
  validTo: Date | null
  timezone: string
  graceMinutes: number
  incrementMinutes: number
  vehicleTypes: string[]
  version: number
  createdAt: Date
  updatedAt: Date
  tiers: TariffDraftTier[]
  windows: TariffDraftWindow[]
  rates: TariffDraftRate[]
  caps: TariffDraftCap[]
}

export interface SimulateQuote {
  durationMinutes: number
  billableMinutes: number
  lineItems: QuoteLineItem[]
  totalCents: number
  currency: string
}

export type SimulateResult = { ok: true; quote: SimulateQuote } | { ok: false; error: string }
