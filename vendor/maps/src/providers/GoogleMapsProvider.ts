import type {
  Address,
  BoundingBox,
  DirectionsOptions,
  DistanceResult,
  GeocodingResult,
  LatLng,
  Place,
  PlaceSearchOptions,
  Route,
  StaticMapOptions,
} from '@spark/types'
import type { IMapProvider } from '../IMapProvider'
import { computeBoundingBox } from '../utils/boundingBox'

export interface GoogleMapsConfig {
  apiKey: string
  language?: string
}

const PLACES_BASE = 'https://places.googleapis.com/v1'
const GEOCODE_BASE = 'https://maps.googleapis.com/maps/api/geocode/json'
const REQUEST_TIMEOUT_MS = 15_000
const MAX_RESULTS = 20

// Field mask controls which fields Google returns (and bills for). businessStatus
// and regularOpeningHours are what the ingestion pipeline enriches OSM with.
const PLACE_FIELDS = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.addressComponents',
  'places.location',
  'places.types',
  'places.businessStatus',
  'places.regularOpeningHours',
].join(',')

// Place Details uses unprefixed field names (no "places." prefix).
const DETAILS_FIELDS = PLACE_FIELDS.replace(/places\./g, '')

interface PlacesV1Component {
  longText: string
  shortText: string
  types: string[]
}

interface PlacesV1OpeningPoint {
  day: number
  hour: number
  minute: number
}

interface PlacesV1Place {
  id: string
  displayName?: { text: string }
  formattedAddress?: string
  addressComponents?: PlacesV1Component[]
  location?: { latitude: number; longitude: number }
  types?: string[]
  businessStatus?: string
  regularOpeningHours?: {
    periods?: Array<{ open?: PlacesV1OpeningPoint; close?: PlacesV1OpeningPoint }>
    weekdayDescriptions?: string[]
  }
}

interface GeocodeComponent {
  long_name: string
  short_name: string
  types: string[]
}

interface GeocodeResult {
  formatted_address: string
  geometry: { location: { lat: number; lng: number }; location_type?: string }
  address_components: GeocodeComponent[]
  place_id: string
}

export class GoogleMapsProvider implements IMapProvider {
  readonly providerName = 'google'

  constructor(private readonly config: GoogleMapsConfig) {}

  async geocode(address: string, language?: string): Promise<GeocodingResult[]> {
    const url = `${GEOCODE_BASE}?address=${encodeURIComponent(address)}&language=${
      language ?? this.config.language ?? 'en'
    }&key=${this.config.apiKey}`
    const data = await this.fetchJson<{ status: string; results: GeocodeResult[] }>(url)
    if (data.status !== 'OK') return []
    return data.results.map((r) => this.mapGeocodeResult(r))
  }

  async reverseGeocode(coordinates: LatLng, language?: string): Promise<GeocodingResult | null> {
    const url = `${GEOCODE_BASE}?latlng=${coordinates.lat},${coordinates.lng}&language=${
      language ?? this.config.language ?? 'en'
    }&key=${this.config.apiKey}`
    const data = await this.fetchJson<{ status: string; results: GeocodeResult[] }>(url)
    if (data.status !== 'OK' || data.results.length === 0) return null
    return this.mapGeocodeResult(data.results[0]!)
  }

  async searchPlaces(query: string, options?: PlaceSearchOptions): Promise<Place[]> {
    const endpoint = options?.location ? 'places:searchNearby' : 'places:searchText'
    const body = options?.location
      ? {
          includedTypes: options.types ?? ['parking'],
          maxResultCount: MAX_RESULTS,
          languageCode: options.language ?? this.config.language,
          locationRestriction: {
            circle: {
              center: { latitude: options.location.lat, longitude: options.location.lng },
              radius: options.radius ?? 1_000,
            },
          },
        }
      : {
          textQuery: query,
          maxResultCount: MAX_RESULTS,
          languageCode: options?.language ?? this.config.language,
        }

    const data = await this.fetchJson<{ places?: PlacesV1Place[] }>(`${PLACES_BASE}/${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': this.config.apiKey,
        'X-Goog-FieldMask': PLACE_FIELDS,
      },
      body: JSON.stringify(body),
    })

    return (data.places ?? []).flatMap((place) => {
      const mapped = this.mapPlace(place)
      return mapped ? [mapped] : []
    })
  }

  async getPlaceDetails(placeId: string): Promise<Place | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const res = await this.safeFetch(`${PLACES_BASE}/places/${encodeURIComponent(placeId)}`, {
        headers: { 'X-Goog-Api-Key': this.config.apiKey, 'X-Goog-FieldMask': DETAILS_FIELDS },
        signal: controller.signal,
      })
      if (res.status === 404) return null
      if (!res.ok) {
        throw new Error(`Google Places details request failed: ${res.status} ${res.statusText}`)
      }
      return this.mapPlace((await res.json()) as PlacesV1Place)
    } finally {
      clearTimeout(timer)
    }
  }

  async getDirections(
    _origin: LatLng,
    _destination: LatLng,
    _options?: DirectionsOptions,
  ): Promise<Route | null> {
    throw new Error('GoogleMapsProvider.getDirections: not implemented')
  }

  async getDistanceMatrix(
    _origins: LatLng[],
    _destinations: LatLng[],
    _options?: DirectionsOptions,
  ): Promise<DistanceResult[]> {
    throw new Error('GoogleMapsProvider.getDistanceMatrix: not implemented')
  }

  getBoundingBox(coordinates: LatLng, radiusMeters: number): BoundingBox {
    return computeBoundingBox(coordinates, radiusMeters)
  }

  getStaticMapUrl(center: LatLng, zoom: number, options?: StaticMapOptions): string {
    const width = options?.width ?? 600
    const height = options?.height ?? 400
    const markers =
      options?.markers
        ?.map((m) => `markers=color:${m.color ?? 'red'}|${m.coordinates.lat},${m.coordinates.lng}`)
        .join('&') ?? ''

    const base = `https://maps.googleapis.com/maps/api/staticmap`
    const params = [
      `center=${center.lat},${center.lng}`,
      `zoom=${zoom}`,
      `size=${width}x${height}`,
      `key=${this.config.apiKey}`,
      markers,
    ]
      .filter(Boolean)
      .join('&')

    return `${base}?${params}`
  }

  private mapPlace(place: PlacesV1Place): Place | null {
    if (!place.location) return null
    const periods = (place.regularOpeningHours?.periods ?? []).flatMap((p) =>
      p.open ? [{ open: p.open, close: p.close }] : [],
    )
    return {
      placeId: place.id,
      name: place.displayName?.text ?? '',
      address: this.addressFromV1Components(
        place.addressComponents ?? [],
        place.formattedAddress ?? '',
      ),
      coordinates: { lat: place.location.latitude, lng: place.location.longitude },
      types: place.types ?? [],
      ...(place.businessStatus ? { businessStatus: place.businessStatus } : {}),
      ...(periods.length > 0
        ? {
            openingHours: {
              periods,
              ...(place.regularOpeningHours?.weekdayDescriptions
                ? { weekdayDescriptions: place.regularOpeningHours.weekdayDescriptions }
                : {}),
            },
          }
        : {}),
    }
  }

  private mapGeocodeResult(result: GeocodeResult): GeocodingResult {
    const confidence =
      result.geometry.location_type === 'ROOFTOP'
        ? 'high'
        : result.geometry.location_type === 'RANGE_INTERPOLATED'
          ? 'medium'
          : 'low'
    return {
      coordinates: { lat: result.geometry.location.lat, lng: result.geometry.location.lng },
      address: this.addressFromLegacyComponents(
        result.address_components,
        result.formatted_address,
      ),
      placeId: result.place_id,
      confidence,
    }
  }

  private addressFromV1Components(components: PlacesV1Component[], formatted: string): Address {
    const find = (type: string) => components.find((c) => c.types.includes(type))
    const country = find('country')
    return {
      formattedAddress: formatted,
      street: find('route')?.longText,
      streetNumber: find('street_number')?.longText,
      city:
        find('locality')?.longText ??
        find('postal_town')?.longText ??
        find('administrative_area_level_3')?.longText ??
        '',
      region: find('administrative_area_level_1')?.longText,
      postalCode: find('postal_code')?.longText,
      country: country?.longText ?? '',
      countryCode: country?.shortText ?? '',
    }
  }

  private addressFromLegacyComponents(components: GeocodeComponent[], formatted: string): Address {
    const find = (type: string) => components.find((c) => c.types.includes(type))
    const country = find('country')
    return {
      formattedAddress: formatted,
      street: find('route')?.long_name,
      streetNumber: find('street_number')?.long_name,
      city:
        find('locality')?.long_name ??
        find('postal_town')?.long_name ??
        find('administrative_area_level_3')?.long_name ??
        '',
      region: find('administrative_area_level_1')?.long_name,
      postalCode: find('postal_code')?.long_name,
      country: country?.long_name ?? '',
      countryCode: country?.short_name ?? '',
    }
  }

  private async fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const res = await this.safeFetch(url, { ...init, signal: controller.signal })
      if (!res.ok) {
        throw new Error(`Google Maps API request failed: ${res.status} ${res.statusText}`)
      }
      return (await res.json()) as T
    } finally {
      clearTimeout(timer)
    }
  }

  // geocode/reverseGeocode carry the API key as a `key=` query param. fetch()'s own
  // network/URL-parse failures echo the request URL into their message, so any such
  // failure is normalized here into a fixed error that cannot carry the key.
  private async safeFetch(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, init)
    } catch {
      throw new Error('Google Maps API request failed: network error')
    }
  }
}
