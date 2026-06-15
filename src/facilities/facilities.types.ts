import type { VehicleType } from '@prisma/client'

export interface FacilitySearchParams {
  lat: number
  lng: number
  radiusMeters: number
  startsAt: Date
  endsAt: Date
  vehicleType?: VehicleType
}

export interface FacilitySearchResult {
  id: string
  name: string
  address: string
  lat: number
  lng: number
  distanceMeters: number
  available: boolean
  remainingSlots: number
  priceCents: number | null
  currency: string
  isPromoted: boolean
  thumbnailUrl: string | null
}
