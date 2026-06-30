import { IngestSource, VehicleType } from '@prisma/client'
import type { AccessClass, CanonicalOpeningHours, CanonicalPlace, CanonicalRule } from './canonical'

export interface OsmInput {
  sourceRef: string
  lat: number
  lng: number
  tags: Record<string, string>
}

const PARKING_LABELS: Record<string, string> = {
  surface: 'Surface parking',
  underground: 'Underground parking',
  'multi-storey': 'Multi-storey parking',
  garage: 'Garage parking',
  street_side: 'Street-side parking',
  lane: 'Street-side parking',
}

const COVERED_TYPES = new Set(['underground', 'multi-storey', 'garage'])

function deriveName(tags: Record<string, string>): string {
  const explicit = tags['name'] ?? tags['name:en'] ?? tags['name:el'] ?? tags['operator']
  if (explicit?.trim()) return explicit.trim()
  return PARKING_LABELS[tags['parking'] ?? ''] ?? 'Parking'
}

function deriveAddress(tags: Record<string, string>): string {
  const street = tags['addr:street']?.trim()
  const houseNumber = tags['addr:housenumber']?.trim()
  const postcode = tags['addr:postcode']?.trim()
  const city = tags['addr:city']?.trim()

  const line1 = [street, houseNumber].filter(Boolean).join(' ')
  const line2 = [postcode, city].filter(Boolean).join(' ')
  return [line1, line2].filter(Boolean).join(', ')
}

function parseCapacity(value: string | undefined): number {
  const n = Number.parseInt(value ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}

// OSM maxheight is metres ("2.1", "2.10 m"). Convert to centimetres; reject values
// outside a sane garage range so a mis-tagged figure can't poison the record.
function parseHeightCm(value: string | undefined): number | null {
  if (!value) return null
  const match = value.match(/([\d.]+)/)
  if (!match) return null
  const metres = Number.parseFloat(match[1] ?? '')
  if (!Number.isFinite(metres) || metres <= 0) return null
  const cm = Math.round(metres * 100)
  return cm >= 100 && cm <= 1000 ? cm : null
}

function parseOpeningHours(value: string | undefined): CanonicalOpeningHours {
  if (value?.trim() === '24/7') return { is24h: true }
  // Anything more structured is left for a later pass / operator onboarding.
  return { is24h: false }
}

function deriveAccess(tags: Record<string, string>): AccessClass {
  switch (tags['access']) {
    case 'private':
      return 'private'
    case 'customers':
      return 'customers'
    default:
      return 'public'
  }
}

function deriveAmenities(tags: Record<string, string>, is24h: boolean): string[] {
  const amenities = new Set<string>()
  if (is24h) amenities.add('24h_access')
  if (COVERED_TYPES.has(tags['parking'] ?? '')) amenities.add('covered')
  if (['yes', 'designated', 'limited'].includes(tags['wheelchair'] ?? '')) {
    amenities.add('disabled_spaces')
  }
  if (tags['supervised'] === 'yes' || 'surveillance' in tags) amenities.add('cctv')
  if ((tags['park_ride'] ?? 'no') !== 'no') amenities.add('park_ride')
  if (tags['fee'] === 'no') amenities.add('free')
  return [...amenities]
}

const RULE_TAGS: Array<[string, string]> = [
  ['parking', 'osm:parking'],
  ['access', 'osm:access'],
  ['fee', 'osm:fee'],
  ['surface', 'osm:surface'],
  ['operator', 'osm:operator'],
  ['park_ride', 'osm:park_ride'],
]

function deriveRules(tags: Record<string, string>): CanonicalRule[] {
  return RULE_TAGS.flatMap(([tag, ruleKey]) => {
    const value = tags[tag]?.trim()
    return value ? [{ ruleKey, ruleValue: value }] : []
  })
}

export function normalizeOsm(input: OsmInput): CanonicalPlace {
  const tags = input.tags ?? {}
  const openingHours = parseOpeningHours(tags['opening_hours'])

  return {
    source: IngestSource.OSM,
    sourceRef: input.sourceRef,
    name: deriveName(tags),
    address: deriveAddress(tags),
    lat: input.lat,
    lng: input.lng,
    totalCapacity: parseCapacity(tags['capacity']),
    vehicleTypes: [VehicleType.CAR],
    heightRestrictionCm: parseHeightCm(tags['maxheight']),
    openingHours,
    amenities: deriveAmenities(tags, openingHours.is24h),
    access: deriveAccess(tags),
    rules: deriveRules(tags),
  }
}
