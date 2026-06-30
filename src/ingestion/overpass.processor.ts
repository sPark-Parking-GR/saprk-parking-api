import { Processor, WorkerHost } from '@nestjs/bullmq'
import { Logger } from '@nestjs/common'
import { IngestSource, Prisma, RawPlaceStatus, TileStatus } from '@prisma/client'
import { createHash } from 'node:crypto'
import type { Job } from 'bullmq'
import { PrismaService } from '../prisma/prisma.service'
import { INGESTION_QUEUE } from './ingestion.constants'
import { OverpassClient } from './overpass.client'
import type { TileFetchJobData } from './ingestion.service'
import type { OverpassElement } from './overpass.types'

@Processor(INGESTION_QUEUE, { concurrency: 1, limiter: { max: 1, duration: 2_000 } })
export class OverpassProcessor extends WorkerHost {
  private readonly logger = new Logger(OverpassProcessor.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly overpass: OverpassClient,
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
      const { elements } = await this.overpass.fetchParkingTile(tile)
      let stored = 0
      for (const element of elements) {
        if (await this.storeElement(element, tileId)) stored++
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
      this.logger.log(`Tile ${tileId}: stored ${stored}/${elements.length} parking element(s)`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.prisma.ingestTile.update({
        where: { id: tileId },
        data: { status: TileStatus.FAILED, lastError: message },
      })
      throw error
    }
  }

  private async storeElement(element: OverpassElement, tileId: string): Promise<boolean> {
    const lat = element.lat ?? element.center?.lat
    const lng = element.lon ?? element.center?.lon
    if (lat == null || lng == null) return false

    const sourceRef = `${element.type}/${element.id}`
    const contentHash = createHash('sha256').update(JSON.stringify(element)).digest('hex')

    const existing = await this.prisma.rawPlace.findUnique({
      where: { source_sourceRef: { source: IngestSource.OSM, sourceRef } },
      select: { contentHash: true },
    })
    if (existing?.contentHash === contentHash) return false

    const raw = element as unknown as Prisma.InputJsonValue
    await this.prisma.rawPlace.upsert({
      where: { source_sourceRef: { source: IngestSource.OSM, sourceRef } },
      create: {
        source: IngestSource.OSM,
        sourceRef,
        sourceType: element.type,
        raw,
        lat,
        lng,
        tileId,
        contentHash,
        status: RawPlaceStatus.PENDING,
      },
      update: {
        raw,
        lat,
        lng,
        tileId,
        contentHash,
        status: RawPlaceStatus.PENDING,
        processedAt: null,
      },
    })
    return true
  }
}
