import { Processor, WorkerHost } from '@nestjs/bullmq'
import { Logger } from '@nestjs/common'
import { Prisma, TileStatus } from '@prisma/client'
import type { Job } from 'bullmq'
import { PrismaService } from '../prisma/prisma.service'
import {
  DEFAULT_TILE_DEGREES,
  GREEK_CITY_REGIONS,
  INGESTION_SWEEP_QUEUE,
  SWEEP_MAX_WAIT_MS,
  SWEEP_POLL_INTERVAL_MS,
} from './ingestion.constants'
import { IngestionService } from './ingestion.service'
import { PromotionService } from './promotion.service'
import type { IngestRegionDto, SweepDto } from './dto/ingestion.dto'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

@Processor(INGESTION_SWEEP_QUEUE, { concurrency: 1 })
export class SweepProcessor extends WorkerHost {
  private readonly logger = new Logger(SweepProcessor.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly ingestion: IngestionService,
    private readonly promotion: PromotionService,
  ) {
    super()
  }

  async process(job: Job<SweepDto>): Promise<void> {
    const regions = this.resolveRegions(job.data)
    this.logger.log(`Sweep start: ${regions.length} region(s)`)

    for (const region of regions) {
      await this.ingestion.enqueueOsmTiles(region)
      await this.ingestion.enqueueGoogleTiles(region)
    }

    const finished = await this.waitForRegions(regions)
    if (!finished) {
      this.logger.warn('Sweep wait ceiling hit; promoting whatever fetched so far')
    }

    const stats = await this.promotion.drainPending()
    this.logger.log(
      `Sweep done: ${stats.created} created, ${stats.merged} merged, ${stats.updated} updated, ` +
        `${stats.duplicate} duplicate, ${stats.rejected} rejected`,
    )
  }

  // City names map to known bboxes; explicit regions pass through. Duplicate cities
  // collapse so a caller can't queue the same area twice in one sweep.
  private resolveRegions(dto: SweepDto): IngestRegionDto[] {
    const cityRegions = [...new Set(dto.cities)].map((city) => {
      const [south, west, north, east] = GREEK_CITY_REGIONS[city]!
      return { south, west, north, east, tileDegrees: DEFAULT_TILE_DEGREES }
    })
    return [...cityRegions, ...dto.regions]
  }

  // Wait on every non-terminal tile that overlaps a swept region, not a fixed id list:
  // Google subtiles are spawned mid-flight when a dense tile truncates, so the barrier
  // has to track tiles that did not exist at enqueue time. Overlap (not containment)
  // catches them since a subtile always lies within its parent region.
  private async waitForRegions(regions: IngestRegionDto[]): Promise<boolean> {
    if (regions.length === 0) return true
    const overlap: Prisma.IngestTileWhereInput = {
      status: { in: [TileStatus.PENDING, TileStatus.FETCHING] },
      OR: regions.map((r) => ({
        south: { lt: r.north },
        north: { gt: r.south },
        west: { lt: r.east },
        east: { gt: r.west },
      })),
    }
    const deadline = Date.now() + SWEEP_MAX_WAIT_MS

    for (;;) {
      if ((await this.prisma.ingestTile.count({ where: overlap })) === 0) return true
      if (Date.now() >= deadline) return false
      await sleep(SWEEP_POLL_INTERVAL_MS)
    }
  }
}
