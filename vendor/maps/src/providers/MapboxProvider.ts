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
import type { IMapProvider } from '../IMapProvider'
import { computeBoundingBox } from '../utils/boundingBox'

export interface MapboxConfig {
  accessToken: string
  language?: string
}

export class MapboxProvider implements IMapProvider {
  readonly providerName = 'mapbox'

  constructor(private readonly config: MapboxConfig) {}

  async geocode(_address: string, _language?: string): Promise<GeocodingResult[]> {
    throw new Error(
      'MapboxProvider.geocode: not implemented — install @mapbox/mapbox-sdk and use mapboxClient.geocoding.forwardGeocode()',
    )
  }

  async reverseGeocode(_coordinates: LatLng, _language?: string): Promise<GeocodingResult | null> {
    throw new Error(
      'MapboxProvider.reverseGeocode: not implemented — use mapboxClient.geocoding.reverseGeocode()',
    )
  }

  async searchPlaces(_query: string, _options?: PlaceSearchOptions): Promise<Place[]> {
    throw new Error(
      'MapboxProvider.searchPlaces: not implemented — use mapboxClient.geocoding.forwardGeocode() with types filter',
    )
  }

  async getPlaceDetails(_placeId: string): Promise<Place | null> {
    throw new Error('MapboxProvider.getPlaceDetails: not implemented')
  }

  async getDirections(
    _origin: LatLng,
    _destination: LatLng,
    _options?: DirectionsOptions,
  ): Promise<Route | null> {
    throw new Error(
      'MapboxProvider.getDirections: not implemented — use mapboxClient.directions.getDirections()',
    )
  }

  async getDistanceMatrix(
    _origins: LatLng[],
    _destinations: LatLng[],
    _options?: DirectionsOptions,
  ): Promise<DistanceResult[]> {
    throw new Error(
      'MapboxProvider.getDistanceMatrix: not implemented — use Mapbox Matrix API via mapboxClient.matrix.getMatrix()',
    )
  }

  getBoundingBox(coordinates: LatLng, radiusMeters: number): BoundingBox {
    return computeBoundingBox(coordinates, radiusMeters)
  }

  getStaticMapUrl(center: LatLng, zoom: number, options?: StaticMapOptions): string {
    const width = options?.width ?? 600
    const height = options?.height ?? 400
    const style = 'mapbox/streets-v12'

    const overlays =
      options?.markers
        ?.map(
          (m) =>
            `pin-s-${m.label ?? 'p'}+${(m.color ?? 'ff0000').replace('#', '')}(${m.coordinates.lng},${m.coordinates.lat})`,
        )
        .join(',') ?? ''

    const overlaySegment = overlays ? `${overlays}/` : ''

    return (
      `https://api.mapbox.com/styles/v1/${style}/static/` +
      `${overlaySegment}${center.lng},${center.lat},${zoom}/` +
      `${width}x${height}` +
      `?access_token=${this.config.accessToken}`
    )
  }
}
