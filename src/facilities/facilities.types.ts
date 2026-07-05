import type { OpeningHours, VehicleType as ContractVehicleType } from '@spark/types'
import type { FacilityKind, IngestSource, VehicleType } from '@prisma/client'

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

export interface ResolvedTariffAssignment {
  vehicleType: VehicleType
  tariffPlanId: string | null
  tariffPlanName: string | null
  source: 'explicit' | 'default' | 'none'
}

export interface FacilityTariffAssignments {
  assignments: ResolvedTariffAssignment[]
  defaultPlan: { id: string; name: string } | null
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
  kind: FacilityKind
  source: IngestSource | null
  operatorId: string
  operatorName: string
  createdAt: Date
  updatedAt: Date
}

export interface AdminFacilityList {
  items: AdminFacilityListItem[]
  total: number
  skip: number
  take: number
}

export interface AdminMapPoint {
  id: string
  name: string
  lat: number
  lng: number
  kind: FacilityKind
  isActive: boolean
  isVerified: boolean
}

export interface AdminMapParams {
  bounds: MapBounds
  q?: string
  isActive?: boolean
  isVerified?: boolean
  kind?: FacilityKind
  operatorId?: string
}

export interface AdminMapResponse {
  mode: 'points' | 'clusters'
  points: AdminMapPoint[]
  clusters: FacilityCluster[]
  total: number
}

export type BulkFacilityAction = 'enable' | 'disable' | 'deploy' | 'delete' | 'assignTariff'

export interface BulkFacilityResult {
  affected: number
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

export interface FacilityCluster {
  id: string
  lat: number
  lng: number
  count: number
}

export interface FacilitySearchResponse {
  mode: 'points' | 'clusters'
  points: FacilitySearchResult[]
  clusters: FacilityCluster[]
  total: number
}
