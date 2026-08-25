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
  operatorId: string | null
  kind: FacilityKind
  name: string
  address: string
  lat: number
  lng: number
  totalCapacity: number
  onlineQuota: number
  bookedOnlineSpots: number
  vehicleTypes: ContractVehicleType[]
  heightRestrictionCm: number | null
  openingHours: OpeningHours
  amenities: string[]
  cancellationPolicy: string
  isActive: boolean
  isPublished: boolean
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
  isPublished: boolean
  kind: FacilityKind
  source: IngestSource | null
  operatorId: string | null
  operatorName: string | null
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
  isPublished: boolean
}

export interface AdminMapParams {
  bounds: MapBounds
  q?: string
  isActive?: boolean
  isPublished?: boolean
  kind?: FacilityKind
  operatorId?: string
}

export interface AdminMapResponse {
  mode: 'points' | 'clusters'
  points: AdminMapPoint[]
  clusters: FacilityCluster[]
  total: number
}

export type BulkFacilityAction =
  | 'enable'
  | 'disable'
  | 'deploy'
  | 'publish'
  | 'unpublish'
  | 'delete'
  | 'assignTariff'

// One facility a bulk disable/delete deliberately left ACTIVE, with the numbers behind
// the decision. `cancelled` is non-zero only for 'refund_failed' and 'archive_failed':
// those bookings really were cancelled and refunded before a later step failed, and
// pretending otherwise would hide money that has already moved. 'archive_failed' means
// the refunds went through but the lifecycle transition itself was refused — a lost race
// against a concurrent booking or archive.
export interface BulkFacilitySkipped {
  facilityId: string
  reason: 'unhonoured_bookings' | 'refund_failed' | 'archive_failed'
  unhonoured: number
  cancelled: number
}

export interface BulkFacilityResult {
  affected: number
  skipped?: BulkFacilitySkipped[]
}

export interface FacilitySearchResult {
  id: string
  name: string
  address: string
  kind: FacilityKind
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
