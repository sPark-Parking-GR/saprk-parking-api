import type {
  BoundingBox,
  DistanceResult,
  DirectionsOptions,
  GeocodingResult,
  LatLng,
  Place,
  PlaceSearchOptions,
  Route,
  StaticMapOptions,
} from '@spark/types'

export interface IMapProvider {
  readonly providerName: string

  geocode(address: string, language?: string): Promise<GeocodingResult[]>

  reverseGeocode(coordinates: LatLng, language?: string): Promise<GeocodingResult | null>

  searchPlaces(query: string, options?: PlaceSearchOptions): Promise<Place[]>

  getPlaceDetails(placeId: string): Promise<Place | null>

  getDirections(
    origin: LatLng,
    destination: LatLng,
    options?: DirectionsOptions,
  ): Promise<Route | null>

  getDistanceMatrix(
    origins: LatLng[],
    destinations: LatLng[],
    options?: DirectionsOptions,
  ): Promise<DistanceResult[]>

  getBoundingBox(coordinates: LatLng, radiusMeters: number): BoundingBox

  getStaticMapUrl(center: LatLng, zoom: number, options?: StaticMapOptions): string
}
