import type { CapScope, RateUnit, VehicleType } from '@prisma/client'

export interface QuoteRequest {
  facilityId: string
  startsAt: Date
  endsAt: Date
  vehicleType: VehicleType
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
  currency: string
  expiresAt: Date
  planId: string
  planVersion: number
}

export const QUOTE_TTL_MINUTES = 10
export const BOOKING_HOLD_MINUTES = 10

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
}
