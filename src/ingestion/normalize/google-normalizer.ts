import { FacilityKind, IngestSource, VehicleType } from '@prisma/client'
import type { Place } from '@spark/types'
import {
  DAY_NAMES,
  type CanonicalOpeningHours,
  type CanonicalPlace,
  type CanonicalRule,
} from './canonical'

const pad = (n: number): string => String(n).padStart(2, '0')
const hhmm = (point: { hour: number; minute: number }): string =>
  `${pad(point.hour)}:${pad(point.minute)}`

function convertOpeningHours(place: Place): CanonicalOpeningHours {
  const periods = place.openingHours?.periods ?? []
  if (periods.length === 0) return { is24h: false }

  // Google encodes 24/7 as a single period opening Sunday 00:00 with no close.
  const [first] = periods
  if (
    periods.length === 1 &&
    first &&
    !first.close &&
    first.open.hour === 0 &&
    first.open.minute === 0
  ) {
    return { is24h: true }
  }

  const schedule: Record<string, { open: string; close: string }> = {}
  for (const period of periods) {
    if (!period.close) continue
    const day = DAY_NAMES[period.open.day]
    if (!day || schedule[day]) continue
    schedule[day] = { open: hhmm(period.open), close: hhmm(period.close) }
  }
  return { is24h: false, schedule }
}

function deriveAmenities(place: Place, is24h: boolean): string[] {
  const amenities = new Set<string>()
  if (is24h) amenities.add('24h_access')
  if (place.types.includes('parking_garage')) amenities.add('covered')
  return [...amenities]
}

function deriveRules(place: Place): CanonicalRule[] {
  const rules: CanonicalRule[] = [{ ruleKey: 'google:place_id', ruleValue: place.placeId }]
  if (place.businessStatus)
    rules.push({ ruleKey: 'google:business_status', ruleValue: place.businessStatus })
  if (place.types.length > 0)
    rules.push({ ruleKey: 'google:types', ruleValue: place.types.join(',') })
  return rules
}

export function normalizeGoogle(place: Place): CanonicalPlace {
  const openingHours = convertOpeningHours(place)
  return {
    source: IngestSource.GOOGLE,
    sourceRef: place.placeId,
    name: place.name,
    address: place.address.formattedAddress,
    lat: place.coordinates.lat,
    lng: place.coordinates.lng,
    // Google Places only surfaces real parking businesses, never free public lots.
    kind: FacilityKind.BUSINESS,
    totalCapacity: 0,
    vehicleTypes: [VehicleType.CAR],
    heightRestrictionCm: null,
    openingHours,
    amenities: deriveAmenities(place, openingHours.is24h),
    rules: deriveRules(place),
    businessStatus: place.businessStatus,
  }
}
