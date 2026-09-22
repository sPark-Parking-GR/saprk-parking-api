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
  INGESTION_SWEEP_QUEUE,
  OVERPASS_FETCH_JOB,
  PROMOTE_OSM_JOB,
  RECLASSIFY_JOB,
  SWEEP_JOB,
} from './ingestion.constants'
import { splitBoundingBox, type Tile } from './tiling'
import type { IngestRegionDto, SweepDto } from './dto/ingestion.dto'

export interface TileFetchJobData {
  tileId: string
  tile: Tile
  // Subdivision depth for Google tiles; absent/0 for a top-level tile.
  depth?: number
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
    @InjectQueue(INGESTION_SWEEP_QUEUE) private readonly sweepQueue: Queue,
  ) {}

  async enqueueSweep(dto: SweepDto): Promise<{ queued: boolean }> {
    await this.sweepQueue.add(SWEEP_JOB, dto, {
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true,
    })
    this.logger.log({ cities: dto.cities.length, regions: dto.regions.length }, 'Enqueued sweep')
    return { queued: true }
  }

  async enqueuePromotion(): Promise<{ queued: boolean }> {
    await this.promoteQueue.add(
      PROMOTE_OSM_JOB,
      {},
      { jobId: 'promote-pending', removeOnComplete: true, removeOnFail: true },
    )
    this.logger.log('Enqueued promotion drain')
    return { queued: true }
  }

  async enqueueReclassify(): Promise<{ queued: boolean }> {
    await this.promoteQueue.add(
      RECLASSIFY_JOB,
      {},
      { jobId: 'reclassify-unknown', removeOnComplete: true, removeOnFail: true },
    )
    this.logger.log('Enqueued reclassify')
    return { queued: true }
  }

  async enqueueRegion(region: IngestRegionDto): Promise<{ tiles: number }> {
    return { tiles: (await this.enqueueOsmTiles(region)).length }
  }

  async enqueueGoogleRegion(region: IngestRegionDto): Promise<{ tiles: number }> {
    return { tiles: (await this.enqueueGoogleTiles(region)).length }
  }

  // Return the tile ids so the sweep orchestrator can wait on exactly these tiles.
  enqueueOsmTiles(region: IngestRegionDto): Promise<string[]> {
    return this.enqueueTiles({
      source: IngestSource.OSM,
      region,
      tileDegrees: region.tileDegrees,
      queue: this.osmQueue,
      jobName: OVERPASS_FETCH_JOB,
      jobPrefix: 'osm',
    })
  }

  enqueueGoogleTiles(region: IngestRegionDto): Promise<string[]> {
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

  // Re-enqueue Google quadrant subtiles when a parent tile truncates at the result
  // cap. Same landing/dedup path as a top-level tile, tagged with the deeper depth.
  async enqueueGoogleSubtiles(tiles: Tile[], depth: number): Promise<void> {
    for (const tile of tiles) {
      await this.enqueueTile(
        IngestSource.GOOGLE,
        tile,
        this.googleQueue,
        GOOGLE_FETCH_JOB,
        'google',
        depth,
      )
    }
    this.logger.log({ count: tiles.length, depth }, 'Enqueued Google subtiles')
  }

  private async enqueueTiles(params: EnqueueParams): Promise<string[]> {
    const { source, region, tileDegrees, queue, jobName, jobPrefix } = params
    const tiles = splitBoundingBox(region, tileDegrees)

    const tileIds: string[] = []
    for (const tile of tiles) {
      tileIds.push(await this.enqueueTile(source, tile, queue, jobName, jobPrefix))
    }

    this.logger.log({ count: tiles.length, source }, 'Enqueued tiles for region')
    return tileIds
  }

  private async enqueueTile(
    source: IngestSource,
    tile: Tile,
    queue: Queue,
    jobName: string,
    jobPrefix: string,
    depth?: number,
  ): Promise<string> {
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

    await queue.add(jobName, { tileId: record.id, tile, depth } satisfies TileFetchJobData, {
      jobId: `${jobPrefix}-${record.id}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      // Remove on finish so the deterministic jobId frees up and a later
      // re-ingest of the same tile actually re-runs. Outcomes are persisted
      // on IngestTile, so the BullMQ record is not the source of truth.
      removeOnComplete: true,
      removeOnFail: true,
    })
    return record.id
  }
}
