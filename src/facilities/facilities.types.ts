import type { OpeningHours, VehicleType as ContractVehicleType } from '@spark/types'
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

export interface AdminFacility {
  id: string
  operatorId: string
  name: string
  address: string
  lat: number
  lng: number
  totalCapacity: number
  onlineQuota: number
  vehicleTypes: ContractVehicleType[]
  heightRestrictionCm: number | null
  openingHours: OpeningHours
  amenities: string[]
  cancellationPolicy: string
  isActive: boolean
  isVerified: boolean
  rank: number
  createdAt: Date
  updatedAt: Date
}

export interface AdminFacilityListItem {
  id: string
  name: string
  address: string
  totalCapacity: number
  onlineQuota: number
  isActive: boolean
  isVerified: boolean
  operatorId: string
  createdAt: Date
  updatedAt: Date
}

export interface AdminFacilityList {
  items: AdminFacilityListItem[]
  total: number
  skip: number
  take: number
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
  // Manual ranking priority; higher sorts first, 0 = unranked.
  rank: number
  thumbnailUrl: string | null
}
