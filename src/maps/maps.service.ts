import { Inject, Injectable } from '@nestjs/common'
import type { MapContext } from '@spark/maps'
import type {
  BoundingBox,
  DirectionsOptions,
  DistanceResult,
  GeocodingResult,
  LatLng,
  Place,
  PlaceSearchOptions,
  Route,
} from '@spark/types'
import { MAP_CONTEXT_TOKEN } from './maps.constants'

@Injectable()
export class MapsService {
  constructor(@Inject(MAP_CONTEXT_TOKEN) private readonly maps: MapContext) {}

  get providerName(): string {
    return this.maps.providerName
  }

  geocode(address: string, language?: string): Promise<GeocodingResult[]> {
    return this.maps.geocode(address, language)
  }

  reverseGeocode(coordinates: LatLng, language?: string): Promise<GeocodingResult | null> {
    return this.maps.reverseGeocode(coordinates, language)
  }

  searchPlaces(query: string, options?: PlaceSearchOptions): Promise<Place[]> {
    return this.maps.searchPlaces(query, options)
  }

  getDirections(
    origin: LatLng,
    destination: LatLng,
    options?: DirectionsOptions,
  ): Promise<Route | null> {
    return this.maps.getDirections(origin, destination, options)
  }

  getDistanceMatrix(
    origins: LatLng[],
    destinations: LatLng[],
    options?: DirectionsOptions,
  ): Promise<DistanceResult[]> {
    return this.maps.getDistanceMatrix(origins, destinations, options)
  }

  getBoundingBox(coordinates: LatLng, radiusMeters: number): BoundingBox {
    return this.maps.getBoundingBox(coordinates, radiusMeters)
  }

  getStaticMapUrl(center: LatLng, zoom: number): string {
    return this.maps.getStaticMapUrl(center, zoom)
  }
}
