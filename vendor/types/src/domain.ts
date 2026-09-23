import type { LatLng } from './maps'

export type Currency = 'EUR'

export type BookingStatus =
  | 'pending_payment'
  | 'confirmed'
  | 'checked_in'
  | 'checked_out'
  | 'cancelled'
  | 'expired'
  | 'refund_pending'
  | 'refunded'

export type VehicleType = 'car' | 'motorcycle' | 'van' | 'truck'

export interface Money {
  amount: number
  currency: Currency
}

export interface Facility {
  id: string
  operatorId: string
  name: string
  address: string
  coordinates: LatLng
  totalCapacity: number
  onlineQuota: number
  vehicleTypes: VehicleType[]
  heightRestrictionCm?: number
  openingHours: OpeningHours
  amenities: string[]
  cancellationPolicy: string
  isActive: boolean
  isPublished: boolean
}

export interface OpeningHours {
  is24h: boolean
  schedule?: Record<string, { open: string; close: string } | null>
}

export interface Booking {
  id: string
  facilityId: string
  userId: string
  vehiclePlate: string
  vehicleType: VehicleType
  startsAt: string
  endsAt: string
  quotedPrice: Money
  finalPrice?: Money
  status: BookingStatus
  accessCode: string
  sourceChannel: 'web' | 'mobile' | 'api'
  createdAt: string
}

export interface PriceQuote {
  facilityId: string
  startsAt: string
  endsAt: string
  durationMinutes: number
  breakdown: Array<{ label: string; amount: Money }>
  total: Money
  currency: Currency
  expiresAt: string
}

export interface Wallet {
  userId: string
  balanceCents: number
  currency: Currency
}
