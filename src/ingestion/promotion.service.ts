import { Injectable, Logger } from '@nestjs/common'
import { FacilityKind, IngestSource, Prisma, RawPlaceStatus, type RawPlace } from '@prisma/client'
import type { Place } from '@spark/types'
import { PrismaService } from '../prisma/prisma.service'
import { ingestFacilitySchema } from './dto/ingestion.dto'
import {
  DEDUP_EXACT_METERS,
  DEDUP_RADIUS_METERS,
  NAME_SIMILARITY_THRESHOLD,
  PROMOTE_BATCH_SIZE,
  UNCLAIMED_OPERATOR_ID,
  UNCLAIMED_OPERATOR_NAME,
} from './ingestion.constants'
import { normalizeGoogle } from './normalize/google-normalizer'
import { classifyOsm, normalizeOsm } from './normalize/osm-normalizer'
import type { CanonicalPlace } from './normalize/canonical'

type Outcome = 'created' | 'merged' | 'updated' | 'duplicate' | 'rejected'

export interface PromotionStats {
  processed: number
  created: number
  merged: number
  updated: number
  duplicate: number
  rejected: number
}

interface DedupRow {
  id: string
  source: string | null
  sourceRef: string | null
  sim: number
  dist: number
}

interface TargetFacility {
  id: string
  source: IngestSource | null
  googlePlaceId: string | null
  name: string
  address: string
  kind: FacilityKind
  totalCapacity: number
  heightRestrictionCm: number | null
  amenities: string[]
}

const TARGET_SELECT = {
  id: true,
  source: true,
  googlePlaceId: true,
  name: true,
  address: true,
  kind: true,
  totalCapacity: true,
  heightRestrictionCm: true,
  amenities: true,
} as const

type Resolution =
  | { kind: 'create' }
  | { kind: 'merge'; facility: TargetFacility; self: boolean }
  | { kind: 'duplicate'; facilityId: string }

@Injectable()
export class PromotionService {
  private readonly logger = new Logger(PromotionService.name)

  constructor(private readonly prisma: PrismaService) {}

  async drainPending(): Promise<PromotionStats> {
    await this.ensureSystemOperator()
    const stats: PromotionStats = {
      processed: 0,
      created: 0,
      merged: 0,
      updated: 0,
      duplicate: 0,
      rejected: 0,
    }

    for (;;) {
      const batch = await this.prisma.rawPlace.findMany({
        where: { status: RawPlaceStatus.PENDING },
        orderBy: { fetchedAt: 'asc' },
        take: PROMOTE_BATCH_SIZE,
      })
      if (batch.length === 0) break

      for (const row of batch) {
        stats[await this.promoteRow(row)]++
        stats.processed++
      }
    }

    this.logger.log(
      `Promotion drained: ${stats.created} created, ${stats.merged} merged, ${stats.updated} updated, ` +
        `${stats.duplicate} duplicate, ${stats.rejected} rejected`,
    )
    return stats
  }

  // Re-run OSM classification over facilities still kind=UNKNOWN using their defining
  // raw tags. Recovers rows ingested before classification existed (or before a
  // classifier improvement); genuinely untagged lots stay UNKNOWN. OSM-only: Google
  // rows are BUSINESS by construction. Never touches operator-owned rows (sourceRef null).
  async reclassifyUnknown(): Promise<{ scanned: number; reclassified: number }> {
    let scanned = 0
    let reclassified = 0
    let cursor: string | undefined

    for (;;) {
      const batch = await this.prisma.facility.findMany({
        where: { kind: FacilityKind.UNKNOWN, source: IngestSource.OSM, sourceRef: { not: null } },
        select: { id: true, sourceRef: true },
        orderBy: { id: 'asc' },
        take: PROMOTE_BATCH_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      })
      if (batch.length === 0) break
      cursor = batch[batch.length - 1]!.id

      for (const facility of batch) {
        scanned++
        const raw = await this.prisma.rawPlace.findUnique({
          where: { source_sourceRef: { source: IngestSource.OSM, sourceRef: facility.sourceRef! } },
          select: { raw: true },
        })
        const tags = ((raw?.raw as { tags?: Record<string, string> })?.tags ?? {}) as Record<string, string>
        const kind = classifyOsm(tags)
        if (kind === FacilityKind.UNKNOWN) continue
        await this.prisma.facility.update({ where: { id: facility.id }, data: { kind } })
        reclassified++
      }
    }

    this.logger.log(`Reclassify: ${reclassified}/${scanned} UNKNOWN OSM facilities reclassified`)
    return { scanned, reclassified }
  }

  private async promoteRow(row: RawPlace): Promise<Outcome> {
    try {
      const canonical = this.normalize(row)

      const parsed = ingestFacilitySchema.safeParse({
        name: canonical.name,
        address: canonical.address,
        lat: canonical.lat,
        lng: canonical.lng,
        totalCapacity: canonical.totalCapacity,
        vehicleTypes: canonical.vehicleTypes,
        heightRestrictionCm: canonical.heightRestrictionCm,
        openingHours: canonical.openingHours,
        amenities: canonical.amenities,
      })
      if (!parsed.success) {
        this.logger.warn(`Rejected ${row.sourceRef}: ${parsed.error.issues[0]?.message ?? 'invalid'}`)
        await this.markRawPlace(row.id, RawPlaceStatus.REJECTED, null)
        return 'rejected'
      }

      const resolution = await this.resolveTarget(canonical)
      if (resolution.kind === 'duplicate') {
        await this.markRawPlace(row.id, RawPlaceStatus.DUPLICATE, resolution.facilityId)
        return 'duplicate'
      }
      if (resolution.kind === 'create') {
        await this.createFacility(row, canonical)
        return 'created'
      }
      await this.mergeFacility(row, canonical, resolution.facility)
      return resolution.self ? 'updated' : 'merged'
    } catch (error) {
      this.logger.error(
        `Failed promoting ${row.sourceRef}`,
        error instanceof Error ? error.message : String(error),
      )
      await this.markRawPlace(row.id, RawPlaceStatus.REJECTED, null)
      return 'rejected'
    }
  }

  private normalize(row: RawPlace): CanonicalPlace {
    if (row.source === IngestSource.GOOGLE) {
      return normalizeGoogle(row.raw as unknown as Place)
    }
    const tags = ((row.raw as { tags?: Record<string, string> })?.tags ?? {}) as Record<string, string>
    return normalizeOsm({ sourceRef: row.sourceRef, lat: row.lat.toNumber(), lng: row.lng.toNumber(), tags })
  }

  // Existing facility this raw row should land on: its own prior promotion (idempotent
  // self target), or a near, similarly-named ingested facility to merge with. A match
  // that is an operator-owned facility (source null) is a duplicate we link but never
  // overwrite — ingested data must not mutate real operator records.
  private async resolveTarget(canonical: CanonicalPlace): Promise<Resolution> {
    const self = await this.findSelf(canonical)
    if (self) return { kind: 'merge', facility: self, self: true }

    const candidate = await this.findDuplicate(canonical)
    if (!candidate) return { kind: 'create' }
    if (candidate.source === null) return { kind: 'duplicate', facilityId: candidate.id }

    const facility = await this.prisma.facility.findUnique({
      where: { id: candidate.id },
      select: TARGET_SELECT,
    })
    return facility ? { kind: 'merge', facility, self: false } : { kind: 'create' }
  }

  private async findSelf(canonical: CanonicalPlace): Promise<TargetFacility | null> {
    if (canonical.source === IngestSource.GOOGLE) {
      return this.prisma.facility.findUnique({
        where: { googlePlaceId: canonical.sourceRef },
        select: TARGET_SELECT,
      })
    }
    return this.prisma.facility.findUnique({
      where: { source_sourceRef: { source: IngestSource.OSM, sourceRef: canonical.sourceRef } },
      select: TARGET_SELECT,
    })
  }

  private async findDuplicate(canonical: CanonicalPlace): Promise<DedupRow | null> {
    const rows = await this.prisma.$queryRaw<DedupRow[]>`
      SELECT id, source::text AS source, "sourceRef",
             similarity(name, ${canonical.name}) AS sim,
             ST_Distance("geog", ST_SetSRID(ST_MakePoint(${canonical.lng}, ${canonical.lat}), 4326)::geography) AS dist
      FROM "Facility"
      WHERE ST_DWithin(
        "geog",
        ST_SetSRID(ST_MakePoint(${canonical.lng}, ${canonical.lat}), 4326)::geography,
        ${DEDUP_RADIUS_METERS}
      )
      ORDER BY "geog" <-> ST_SetSRID(ST_MakePoint(${canonical.lng}, ${canonical.lat}), 4326)::geography
      LIMIT 5`

    for (const row of rows) {
      if (row.source === canonical.source && row.sourceRef === canonical.sourceRef) continue
      if (row.dist <= DEDUP_EXACT_METERS || row.sim >= NAME_SIMILARITY_THRESHOLD) return row
    }
    return null
  }

  private async createFacility(row: RawPlace, canonical: CanonicalPlace): Promise<void> {
    const isGoogle = canonical.source === IngestSource.GOOGLE
    await this.prisma.$transaction(async (tx) => {
      const facility = await tx.facility.create({
        data: {
          name: canonical.name,
          address: canonical.address,
          lat: canonical.lat,
          lng: canonical.lng,
          kind: canonical.kind,
          totalCapacity: canonical.totalCapacity,
          onlineQuota: 0,
          vehicleTypes: canonical.vehicleTypes,
          heightRestrictionCm: canonical.heightRestrictionCm,
          openingHoursJson: canonical.openingHours as unknown as Prisma.InputJsonValue,
          amenities: canonical.amenities,
          isActive: false,
          isVerified: false,
          operatorId: UNCLAIMED_OPERATOR_ID,
          source: canonical.source,
          sourceRef: canonical.sourceRef,
          sourceUpdatedAt: new Date(),
          contentHash: row.contentHash,
          ...(isGoogle ? { googlePlaceId: canonical.sourceRef, googleSyncedAt: new Date() } : {}),
        },
        select: { id: true },
      })

      if (canonical.rules.length > 0) {
        await tx.facilityRule.createMany({
          data: canonical.rules.map((rule) => ({ facilityId: facility.id, ...rule })),
          skipDuplicates: true,
        })
      }
      await this.linkRaw(tx, row.id, facility.id)
    })
  }

  // Source precedence: Google wins display fields (name/address/hours), OSM wins
  // physical fields (capacity/height). OSM never overwrites Google-provided display
  // fields once a facility carries a googlePlaceId.
  private async mergeFacility(
    row: RawPlace,
    canonical: CanonicalPlace,
    target: TargetFacility,
  ): Promise<void> {
    const now = new Date()
    const amenities = [...new Set([...target.amenities, ...canonical.amenities])]
    const rules = [...canonical.rules]
    const data: Prisma.FacilityUpdateInput = { amenities }

    if (canonical.source === IngestSource.GOOGLE) {
      if (canonical.name) data.name = canonical.name
      if (canonical.address) data.address = canonical.address
      data.openingHoursJson = canonical.openingHours as unknown as Prisma.InputJsonValue
      data.googlePlaceId = canonical.sourceRef
      data.googleSyncedAt = now
      // Google confirms a real business — authoritative on kind, overriding an OSM guess.
      data.kind = FacilityKind.BUSINESS
      if (target.source === IngestSource.GOOGLE) {
        data.sourceUpdatedAt = now
        data.contentHash = row.contentHash
      }
    } else {
      if (canonical.totalCapacity > 0) data.totalCapacity = canonical.totalCapacity
      if (canonical.heightRestrictionCm !== null) data.heightRestrictionCm = canonical.heightRestrictionCm
      // Never downgrade a Google-confirmed business; otherwise let OSM fill an
      // unclassified row but not overwrite an existing, more specific classification.
      if (!target.googlePlaceId && target.kind === FacilityKind.UNKNOWN && canonical.kind !== FacilityKind.UNKNOWN) {
        data.kind = canonical.kind
      }
      if (!target.googlePlaceId) {
        data.name = canonical.name
        if (canonical.address) data.address = canonical.address
        data.openingHoursJson = canonical.openingHours as unknown as Prisma.InputJsonValue
      }
      if (target.source === IngestSource.OSM) {
        data.sourceUpdatedAt = now
        data.contentHash = row.contentHash
      } else {
        rules.push({ ruleKey: 'osm:ref', ruleValue: canonical.sourceRef })
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.facility.update({ where: { id: target.id }, data })
      for (const rule of rules) {
        await tx.facilityRule.upsert({
          where: { facilityId_ruleKey: { facilityId: target.id, ruleKey: rule.ruleKey } },
          create: { facilityId: target.id, ...rule },
          update: { ruleValue: rule.ruleValue },
        })
      }
      await this.linkRaw(tx, row.id, target.id)
    })
  }

  private linkRaw(tx: Prisma.TransactionClient, rawId: string, facilityId: string): Promise<unknown> {
    return tx.rawPlace.update({
      where: { id: rawId },
      data: { status: RawPlaceStatus.PROCESSED, facilityId, processedAt: new Date() },
    })
  }

  private async markRawPlace(id: string, status: RawPlaceStatus, facilityId: string | null): Promise<void> {
    await this.prisma.rawPlace.update({
      where: { id },
      data: { status, facilityId, processedAt: new Date() },
    })
  }

  private async ensureSystemOperator(): Promise<void> {
    await this.prisma.parkingOperator.upsert({
      where: { id: UNCLAIMED_OPERATOR_ID },
      create: { id: UNCLAIMED_OPERATOR_ID, name: UNCLAIMED_OPERATOR_NAME },
      update: {},
    })
  }
}
