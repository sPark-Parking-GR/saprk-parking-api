import type { BookingStatus, VehicleType } from '@prisma/client'

export interface CreateBookingRequest {
  facilityId: string
  startsAt: Date
  endsAt: Date
  vehicleType: VehicleType
  vehiclePlate: string
  idempotencyKey: string
  userId?: string
  vehicleId?: string
  guestEmail?: string
  guestPhone?: string
  sourceChannel?: 'WEB' | 'MOBILE' | 'API'
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
