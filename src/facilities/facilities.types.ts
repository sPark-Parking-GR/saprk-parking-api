import type { VehicleType } from '@prisma/client'

export interface MapBounds {
  north: number
  south: number
  east: number
  west: number
}

export interface FacilitySearchParams {
  lat: number
  lng: number
  radiusMeters: number
  // When present, results are filtered to this rectangle (the visible map area)
  // instead of the lat/lng + radius circle.
  bounds?: MapBounds
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
