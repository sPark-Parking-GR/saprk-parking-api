import type { IngestSource, VehicleType } from '@prisma/client'

export type AccessClass = 'public' | 'private' | 'customers'

export interface CanonicalRule {
  ruleKey: string
  ruleValue: string
}

export interface CanonicalOpeningHours {
  is24h: boolean
  schedule?: Record<string, { open: string; close: string } | null>
}

// Source-neutral shape both normalizers produce and the promotion stage consumes.
// Optional fields carry source-specific extras (OSM access, Google place id/status).
export interface CanonicalPlace {
  source: IngestSource
  sourceRef: string
  name: string
  address: string
  lat: number
  lng: number
  totalCapacity: number
  vehicleTypes: VehicleType[]
  heightRestrictionCm: number | null
  openingHours: CanonicalOpeningHours
  amenities: string[]
  rules: CanonicalRule[]
  access?: AccessClass
  businessStatus?: string
}

export const DAY_NAMES = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const
