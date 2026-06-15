import type { VehicleType } from '@prisma/client'

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
