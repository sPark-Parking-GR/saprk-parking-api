export interface LatLng {
  lat: number
  lng: number
}

export interface BoundingBox {
  northeast: LatLng
  southwest: LatLng
}

export interface Address {
  formattedAddress: string
  street?: string
  streetNumber?: string
  city: string
  region?: string
  postalCode?: string
  country: string
  countryCode: string
}

export interface GeocodingResult {
  coordinates: LatLng
  address: Address
  placeId?: string
  confidence: 'high' | 'medium' | 'low'
}

export interface PlaceSearchOptions {
  location?: LatLng
  radius?: number
  language?: string
  types?: string[]
}

export interface PlaceOpeningPeriodPoint {
  day: number
  hour: number
  minute: number
}

export interface PlaceOpeningHours {
  periods: Array<{ open: PlaceOpeningPeriodPoint; close?: PlaceOpeningPeriodPoint }>
  weekdayDescriptions?: string[]
}

export interface Place {
  placeId: string
  name: string
  address: Address
  coordinates: LatLng
  types: string[]
  businessStatus?: string
  openingHours?: PlaceOpeningHours
}

export interface DirectionsOptions {
  mode?: 'driving' | 'walking' | 'transit'
  language?: string
}

export interface RouteStep {
  instruction: string
  distance: number
  duration: number
  startLocation: LatLng
  endLocation: LatLng
}

export interface Route {
  distanceMeters: number
  durationSeconds: number
  polyline?: string
  steps: RouteStep[]
}

export interface DistanceResult {
  originIndex: number
  destinationIndex: number
  distanceMeters: number
  durationSeconds: number
}

export interface StaticMapOptions {
  width?: number
  height?: number
  zoom?: number
  markers?: Array<{ coordinates: LatLng; color?: string; label?: string }>
}

export type MapProviderName = 'google' | 'mapbox' | 'openstreetmap'
