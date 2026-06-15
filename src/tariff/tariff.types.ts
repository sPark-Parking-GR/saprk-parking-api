import type { VehicleType } from '@prisma/client'

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
}

export const QUOTE_TTL_MINUTES = 10
export const BOOKING_HOLD_MINUTES = 10
