import type { RevenueBucket } from './dto/analytics.dto'

export interface RevenueTotals {
  /** Money captured: every payment that reached a settled state in the range. */
  grossRevenueCents: number
  /** Money handed back: successful refunds against those payments. */
  refundedCents: number
  /** gross − refunded. THE revenue figure; a fully refunded booking contributes zero. */
  netRevenueCents: number
  /** Bookings whose payment settled in the range and was not fully refunded. */
  bookingCount: number
}

export interface OccupancySummary {
  /** Slot-minutes actually taken by occupying bookings inside the range. */
  bookedSlotMinutes: number
  /** Slot-minutes offered: online quota × owned minutes, summed over the facilities. */
  capacitySlotMinutes: number
  /** booked / capacity, 0 when nothing was offered. Not a percentage. */
  ratio: number
}

export interface AnalyticsSummary extends RevenueTotals {
  range: { from: Date; to: Date }
  currency: string
  /** netRevenueCents / bookingCount, rounded to whole cents. 0 when there are none. */
  averageTicketCents: number
  occupancy: OccupancySummary
}

/**
 * The deeper cut of the same panels, sold as `analytics.advanced`: the range against the
 * one immediately before it, so a number can be read as a trend rather than a level.
 *
 * The previous range is the SAME LENGTH and ends where the current one begins, so the two
 * tile without overlap and a month is never compared against a fortnight.
 */
export interface AnalyticsComparison {
  current: AnalyticsSummary
  previous: AnalyticsSummary
  netRevenueDeltaCents: number
  bookingCountDelta: number
  /** Difference of two ratios, so it is in ratio units too — not percentage points. */
  occupancyRatioDelta: number
}

export interface RevenuePoint extends RevenueTotals {
  bucketStart: Date
}

export interface RevenueSeries {
  range: { from: Date; to: Date }
  bucket: RevenueBucket
  currency: string
  points: RevenuePoint[]
}

export interface TopFacility extends RevenueTotals {
  facilityId: string
  facilityName: string
  /** The operator the revenue is attributed to — the period owner, not the current one. */
  operatorId: string
}

export interface TopFacilities {
  range: { from: Date; to: Date }
  currency: string
  items: TopFacility[]
}
