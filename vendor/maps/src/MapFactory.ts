import { MapContext } from './MapContext'
import type { IMapProvider } from './IMapProvider'
import { GoogleMapsProvider } from './providers/GoogleMapsProvider'
import { MapboxProvider } from './providers/MapboxProvider'
import type { GoogleMapsConfig } from './providers/GoogleMapsProvider'
import type { MapboxConfig } from './providers/MapboxProvider'

export type MapProviderConfig =
  { provider: 'google'; config: GoogleMapsConfig } | { provider: 'mapbox'; config: MapboxConfig }

export function createMapProvider(options: MapProviderConfig): IMapProvider {
  switch (options.provider) {
    case 'google':
      return new GoogleMapsProvider(options.config)
    case 'mapbox':
      return new MapboxProvider(options.config)
  }
}

export function createMapContext(options: MapProviderConfig): MapContext {
  return new MapContext(createMapProvider(options))
}
