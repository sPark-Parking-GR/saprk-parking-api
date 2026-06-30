import { InjectQueue } from '@nestjs/bullmq'
import { Injectable, Logger } from '@nestjs/common'
import { IngestSource, TileStatus } from '@prisma/client'
import { Queue } from 'bullmq'
import { PrismaService } from '../prisma/prisma.service'
import {
  DEFAULT_GOOGLE_TILE_DEGREES,
  GOOGLE_FETCH_JOB,
  INGESTION_GOOGLE_QUEUE,
  INGESTION_PROMOTE_QUEUE,
  INGESTION_QUEUE,
  OVERPASS_FETCH_JOB,
  PROMOTE_OSM_JOB,
} from './ingestion.constants'
import { splitBoundingBox, type Tile } from './tiling'
import type { IngestRegionDto } from './dto/ingestion.dto'

export interface TileFetchJobData {
  tileId: string
  tile: Tile
}

interface EnqueueParams {
  source: IngestSource
  region: IngestRegionDto
  tileDegrees: number
  queue: Queue
  jobName: string
  jobPrefix: string
}

@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name)

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(INGESTION_QUEUE) private readonly osmQueue: Queue,
    @InjectQueue(INGESTION_GOOGLE_QUEUE) private readonly googleQueue: Queue,
    @InjectQueue(INGESTION_PROMOTE_QUEUE) private readonly promoteQueue: Queue,
  ) {}

  async enqueuePromotion(): Promise<{ queued: boolean }> {
    await this.promoteQueue.add(
      PROMOTE_OSM_JOB,
      {},
      { jobId: 'promote-pending', removeOnComplete: true, removeOnFail: true },
    )
    this.logger.log('Enqueued promotion drain')
    return { queued: true }
  }

  enqueueRegion(region: IngestRegionDto): Promise<{ tiles: number }> {
    return this.enqueueTiles({
      source: IngestSource.OSM,
      region,
      tileDegrees: region.tileDegrees,
      queue: this.osmQueue,
      jobName: OVERPASS_FETCH_JOB,
      jobPrefix: 'osm',
    })
  }

  enqueueGoogleRegion(region: IngestRegionDto): Promise<{ tiles: number }> {
    return this.enqueueTiles({
      source: IngestSource.GOOGLE,
      region,
      // Google's 20-result cap needs finer tiles than the OSM default.
      tileDegrees: Math.min(region.tileDegrees, DEFAULT_GOOGLE_TILE_DEGREES),
      queue: this.googleQueue,
      jobName: GOOGLE_FETCH_JOB,
      jobPrefix: 'google',
    })
  }

  private async enqueueTiles(params: EnqueueParams): Promise<{ tiles: number }> {
    const { source, region, tileDegrees, queue, jobName, jobPrefix } = params
    const tiles = splitBoundingBox(region, tileDegrees)

    for (const tile of tiles) {
      const record = await this.prisma.ingestTile.upsert({
        where: {
          source_south_west_north_east: {
            source,
            south: tile.south,
            west: tile.west,
            north: tile.north,
            east: tile.east,
          },
        },
        create: { source, ...tile, status: TileStatus.PENDING },
        update: { status: TileStatus.PENDING, lastError: null },
      })

      await queue.add(
        jobName,
        { tileId: record.id, tile } satisfies TileFetchJobData,
        {
          jobId: `${jobPrefix}-${record.id}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
          // Remove on finish so the deterministic jobId frees up and a later
          // re-ingest of the same tile actually re-runs. Outcomes are persisted
          // on IngestTile, so the BullMQ record is not the source of truth.
          removeOnComplete: true,
          removeOnFail: true,
        },
      )
    }

    this.logger.log(`Enqueued ${tiles.length} ${source} tile(s) for region`)
    return { tiles: tiles.length }
  }
}
