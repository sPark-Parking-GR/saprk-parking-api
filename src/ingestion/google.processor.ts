import { Processor, WorkerHost } from '@nestjs/bullmq'
import { Logger } from '@nestjs/common'
import { IngestSource, Prisma, RawPlaceStatus, TileStatus } from '@prisma/client'
import type { Place } from '@spark/types'
import type { Job } from 'bullmq'
import { createHash } from 'node:crypto'
import { MapsService } from '../maps/maps.service'
import { PrismaService } from '../prisma/prisma.service'
import {
  GOOGLE_MAX_RESULTS,
  GOOGLE_NEARBY_RADIUS_METERS,
  INGESTION_GOOGLE_QUEUE,
} from './ingestion.constants'
import type { TileFetchJobData } from './ingestion.service'

@Processor(INGESTION_GOOGLE_QUEUE, { concurrency: 1, limiter: { max: 5, duration: 1_000 } })
export class GoogleFetchProcessor extends WorkerHost {
  private readonly logger = new Logger(GoogleFetchProcessor.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly maps: MapsService,
  ) {
    super()
  }

  async process(job: Job<TileFetchJobData>): Promise<void> {
    const { tileId, tile } = job.data
    await this.prisma.ingestTile.update({
      where: { id: tileId },
      data: { status: TileStatus.FETCHING },
    })

    try {
      const center = { lat: (tile.south + tile.north) / 2, lng: (tile.west + tile.east) / 2 }
      const places = await this.maps.searchPlaces('', {
        location: center,
        radius: GOOGLE_NEARBY_RADIUS_METERS,
        types: ['parking'],
      })

      let stored = 0
      for (const place of places) {
        if (await this.storePlace(place, tileId)) stored++
      }

      if (places.length >= GOOGLE_MAX_RESULTS) {
        this.logger.warn(`Tile ${tileId} hit the ${GOOGLE_MAX_RESULTS}-result cap — possible truncation`)
      }

      await this.prisma.ingestTile.update({
        where: { id: tileId },
        data: {
          status: TileStatus.FETCHED,
          resultCount: stored,
          lastFetchedAt: new Date(),
          lastError: null,
        },
      })
      this.logger.log(`Tile ${tileId}: stored ${stored}/${places.length} Google place(s)`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.prisma.ingestTile.update({
        where: { id: tileId },
        data: { status: TileStatus.FAILED, lastError: message },
      })
      throw error
    }
  }

  private async storePlace(place: Place, tileId: string): Promise<boolean> {
    const contentHash = createHash('sha256').update(JSON.stringify(place)).digest('hex')

    const existing = await this.prisma.rawPlace.findUnique({
      where: { source_sourceRef: { source: IngestSource.GOOGLE, sourceRef: place.placeId } },
      select: { contentHash: true },
    })
    if (existing?.contentHash === contentHash) return false

    const raw = place as unknown as Prisma.InputJsonValue
    await this.prisma.rawPlace.upsert({
      where: { source_sourceRef: { source: IngestSource.GOOGLE, sourceRef: place.placeId } },
      create: {
        source: IngestSource.GOOGLE,
        sourceRef: place.placeId,
        sourceType: 'place',
        raw,
        lat: place.coordinates.lat,
        lng: place.coordinates.lng,
        tileId,
        contentHash,
        status: RawPlaceStatus.PENDING,
      },
      update: {
        raw,
        lat: place.coordinates.lat,
        lng: place.coordinates.lng,
        tileId,
        contentHash,
        status: RawPlaceStatus.PENDING,
        processedAt: null,
      },
    })
    return true
  }
}
