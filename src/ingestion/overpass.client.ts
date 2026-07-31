import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import {
  DEFAULT_OVERPASS_URL,
  OVERPASS_TIMEOUT_MS,
  OVERPASS_USER_AGENT,
} from './ingestion.constants'
import type { OverpassResponse } from './overpass.types'
import type { Tile } from './tiling'

@Injectable()
export class OverpassClient {
  private readonly endpoint: string

  constructor(config: ConfigService) {
    this.endpoint = config.get<string>('OVERPASS_URL') ?? DEFAULT_OVERPASS_URL
  }

  async fetchParkingTile(tile: Tile): Promise<OverpassResponse> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), OVERPASS_TIMEOUT_MS)
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': OVERPASS_USER_AGENT,
        },
        body: new URLSearchParams({ data: this.buildQuery(tile) }),
        signal: controller.signal,
      })
      if (!res.ok) {
        throw new Error(`Overpass responded ${res.status} ${res.statusText}`)
      }
      return (await res.json()) as OverpassResponse
    } finally {
      clearTimeout(timer)
    }
  }

  private buildQuery(tile: Tile): string {
    const bbox = `${tile.south},${tile.west},${tile.north},${tile.east}`
    const timeout = Math.floor(OVERPASS_TIMEOUT_MS / 1000)
    return `[out:json][timeout:${timeout}];(nwr["amenity"="parking"](${bbox}););out center tags;`
  }
}
