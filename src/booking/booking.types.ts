import type { BookingStatus, PaymentStatus, RefundStatus, VehicleType } from '@prisma/client'

export interface CreateBookingRequest {
  facilityId: string
  startsAt: Date
  endsAt: Date
  vehicleType: VehicleType
  vehiclePlate: string
  idempotencyKey: string
  userId: string
  sourceChannel: 'WEB' | 'MOBILE' | 'API'
  vehicleId?: string
}

export interface BookingResult {
  bookingId: string
  accessCode: string
  expiresAt: Date
  amountCents: number
  currency: string
  clientSecret?: string
  alreadyExisted: boolean
}

export interface ConfirmedBooking {
  bookingId: string
  accessCode: string
  status: string
  startsAt: Date
  endsAt: Date
  finalPriceCents: number
  currency: string
}

export interface BookingListItem {
  id: string
  accessCode: string
  status: BookingStatus
  startsAt: Date
  endsAt: Date
  vehiclePlate: string
  vehicleType: VehicleType
  quotedPriceCents: number
  finalPriceCents: number | null
  currency: string
  facility: { id: string; name: string }
  createdAt: Date
}

export interface BookingList {
  items: BookingListItem[]
  total: number
  skip: number
  take: number
}

// getBooking's payload. Deliberately never carries qrSecret (the live QR credential) —
// see BookingService.getBooking. Payment/Refund omit provider-side identifiers
// (providerPaymentId, providerRefundId): nothing here needs them, so they stay internal.
// Same shape for the owning consumer and for scoped staff; both are already authorized
// by assertBookingAccess and both legitimately need the customer identity and the
// payment/refund state to make sense of the booking.
export interface BookingDetail {
  id: string
  accessCode: string
  status: BookingStatus
  startsAt: Date
  endsAt: Date
  vehiclePlate: string
  vehicleType: VehicleType
  quotedPriceCents: number
  finalPriceCents: number | null
  priceAdjustmentCents: number | null
  currency: string
  createdAt: Date
  facility: { id: string; name: string; address: string }
  user: { email: string; displayName: string | null }
  payment: {
    status: PaymentStatus
    amountCents: number
    currency: string
    provider: string
    createdAt: Date
  } | null
  refund: {
    status: RefundStatus
    amountCents: number
    reason: string | null
    createdAt: Date
  } | null
  statusHistory: Array<{
    id: string
    status: BookingStatus
    note: string | null
    changedBy: string | null
    changedAt: Date
  }>
}

// The subset of a booking check-out repricing needs: the booked start, the price the
// customer agreed to, the plan revision that produced it, and whose booking it is — the
// last so a subscribed rider's discount survives to the final price instead of being applied
// at quote time and silently dropped at check-out.
export interface PinnedStay {
  id: string
  userId: string
  startsAt: Date
  quotedPriceCents: number
  currency: string
  tariffPlanId: string | null
  tariffPlanVersion: number | null
}

export type RepriceOutcome =
  | 'repriced'
  | 'not_pinned'
  | 'no_billable_stay'
  | 'plan_version_changed'
  | 'currency_mismatch'
  | 'reprice_failed'

export interface RepricedStay {
  finalPriceCents: number
  // Signed difference against the quote, null when the quote stands. Recorded only —
  // check-out never charges or refunds it.
  adjustmentCents: number | null
  outcome: RepriceOutcome
  note: string
}
