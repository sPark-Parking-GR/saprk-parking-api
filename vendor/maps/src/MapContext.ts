import type {
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
import type { IMapProvider } from './IMapProvider'

export class MapContext {
  constructor(private provider: IMapProvider) {}

  get providerName(): string {
    return this.provider.providerName
  }

  setProvider(provider: IMapProvider): void {
    this.provider = provider
  }

  geocode(address: string, language?: string): Promise<GeocodingResult[]> {
    return this.provider.geocode(address, language)
  }

  reverseGeocode(coordinates: LatLng, language?: string): Promise<GeocodingResult | null> {
    return this.provider.reverseGeocode(coordinates, language)
  }

  searchPlaces(query: string, options?: PlaceSearchOptions): Promise<Place[]> {
    return this.provider.searchPlaces(query, options)
  }

  getPlaceDetails(placeId: string): Promise<Place | null> {
    return this.provider.getPlaceDetails(placeId)
  }

  getDirections(
    origin: LatLng,
    destination: LatLng,
    options?: DirectionsOptions,
  ): Promise<Route | null> {
    return this.provider.getDirections(origin, destination, options)
  }

  getDistanceMatrix(
    origins: LatLng[],
    destinations: LatLng[],
    options?: DirectionsOptions,
  ): Promise<DistanceResult[]> {
    return this.provider.getDistanceMatrix(origins, destinations, options)
  }

  getBoundingBox(coordinates: LatLng, radiusMeters: number): BoundingBox {
    return this.provider.getBoundingBox(coordinates, radiusMeters)
  }

  getStaticMapUrl(center: LatLng, zoom: number, options?: StaticMapOptions): string {
    return this.provider.getStaticMapUrl(center, zoom, options)
  }
}
