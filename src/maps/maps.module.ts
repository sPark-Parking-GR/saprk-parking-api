import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createMapContext } from '@spark/maps'
import type { MapProviderConfig } from '@spark/maps'
import { MAP_CONTEXT_TOKEN } from './maps.constants'
import { MapsService } from './maps.service'

@Module({
  providers: [
    {
      provide: MAP_CONTEXT_TOKEN,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const provider = (config.get<string>('MAP_PROVIDER') ?? 'google') as MapProviderConfig['provider']

        switch (provider) {
          case 'google':
            return createMapContext({
              provider: 'google',
              config: { apiKey: config.getOrThrow('GOOGLE_MAPS_API_KEY') },
            })
          case 'mapbox':
            return createMapContext({
              provider: 'mapbox',
              config: { accessToken: config.getOrThrow('MAPBOX_ACCESS_TOKEN') },
            })
          default:
            throw new Error(`Unknown MAP_PROVIDER: ${provider}`)
        }
      },
    },
    MapsService,
  ],
  exports: [MapsService],
})
export class MapsModule {}
