import { InjectQueue } from '@nestjs/bullmq'
import { Injectable, Logger } from '@nestjs/common'
import { FacilityKind, Prisma } from '@prisma/client'
import { Queue } from 'bullmq'
import { MapsService } from '../maps/maps.service'
import { PrismaService } from '../prisma/prisma.service'
import {
  GOOGLE_REFRESH_JOB,
  GOOGLE_SYNC_TTL_DAYS,
  INGESTION_REFRESH_QUEUE,
  REFRESH_BATCH_SIZE,
  REFRESH_MAX_PER_RUN,
} from './ingestion.constants'
import { normalizeGoogle } from './normalize/google-normalizer'

export interface RefreshStats {
  refreshed: number
  notFound: number
}

interface StaleFacility {
  id: string
  googlePlaceId: string
  amenities: string[]
}

@Injectable()
export class RefreshService {
  private readonly logger = new Logger(RefreshService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly maps: MapsService,
    @InjectQueue(INGESTION_REFRESH_QUEUE) private readonly queue: Queue,
  ) {}

  async enqueue(): Promise<{ queued: boolean }> {
    await this.queue.add(
      GOOGLE_REFRESH_JOB,
      {},
      { jobId: 'google-refresh', removeOnComplete: true, removeOnFail: true },
    )
    return { queued: true }
  }

  async refreshStale(): Promise<RefreshStats> {
    const cutoff = new Date(Date.now() - GOOGLE_SYNC_TTL_DAYS * 24 * 60 * 60 * 1_000)
    const stats: RefreshStats = { refreshed: 0, notFound: 0 }
    let processed = 0

    while (processed < REFRESH_MAX_PER_RUN) {
      const batch = await this.prisma.facility.findMany({
        where: {
          googlePlaceId: { not: null },
          OR: [{ googleSyncedAt: null }, { googleSyncedAt: { lt: cutoff } }],
        },
        orderBy: { googleSyncedAt: { sort: 'asc', nulls: 'first' } },
        take: Math.min(REFRESH_BATCH_SIZE, REFRESH_MAX_PER_RUN - processed),
        select: { id: true, googlePlaceId: true, amenities: true },
      })
      if (batch.length === 0) break

      for (const facility of batch) {
        if (await this.refreshOne(facility as StaleFacility)) stats.refreshed++
        else stats.notFound++
        processed++
      }
    }

    const remaining = await this.countStale(cutoff)
    this.logger.log(
      `Google refresh: ${stats.refreshed} refreshed, ${stats.notFound} not found, ${remaining} still stale`,
    )
    return stats
  }

  private async refreshOne(facility: StaleFacility): Promise<boolean> {
    const place = await this.maps.getPlaceDetails(facility.googlePlaceId)

    // Place gone from Google: stamp synced so it drops out of the stale set rather
    // than being retried every run. Cached fields are left intact.
    if (!place) {
      await this.prisma.facility.update({
        where: { id: facility.id },
        data: { googleSyncedAt: new Date() },
      })
      return false
    }

    const canonical = normalizeGoogle(place)
    const amenities = [...new Set([...facility.amenities, ...canonical.amenities])]

    await this.prisma.$transaction(async (tx) => {
      await tx.facility.update({
        where: { id: facility.id },
        data: {
          ...(canonical.name ? { name: canonical.name } : {}),
          ...(canonical.address ? { address: canonical.address } : {}),
          openingHoursJson: canonical.openingHours as unknown as Prisma.InputJsonValue,
          amenities,
          // A live Google place is a business — keep kind in sync so rows synced before
          // classification existed self-heal on refresh.
          kind: FacilityKind.BUSINESS,
          googleSyncedAt: new Date(),
        },
      })
      for (const rule of canonical.rules) {
        await tx.facilityRule.upsert({
          where: { facilityId_ruleKey: { facilityId: facility.id, ruleKey: rule.ruleKey } },
          create: { facilityId: facility.id, ...rule },
          update: { ruleValue: rule.ruleValue },
        })
      }
    })
    return true
  }

  private countStale(cutoff: Date): Promise<number> {
    return this.prisma.facility.count({
      where: {
        googlePlaceId: { not: null },
        OR: [{ googleSyncedAt: null }, { googleSyncedAt: { lt: cutoff } }],
      },
    })
  }
}
