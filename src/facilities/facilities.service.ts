import { Injectable } from '@nestjs/common'
import { computeDistanceMeters } from '@parqin/maps'
import { PromotionType } from '@prisma/client'
import { FacilityNotFoundError } from '../common/errors/domain.errors'
import { InventoryService } from '../inventory/inventory.service'
import { PrismaService } from '../prisma/prisma.service'
import { TariffService } from '../tariff/tariff.service'
import type { FacilitySearchParams, FacilitySearchResult, MapBounds } from './facilities.types'

const PROMOTION_WEIGHT: Record<PromotionType, number> = {
  [PromotionType.PREMIUM]: 3,
  [PromotionType.FEATURED]: 2,
  [PromotionType.STANDARD]: 1,
}

@Injectable()
export class FacilitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly tariff: TariffService,
  ) {}

  async search(params: FacilitySearchParams): Promise<FacilitySearchResult[]> {
    const { lat, lng, radiusMeters, bounds, startsAt, endsAt, vehicleType } = params

    // GiST-indexed spatial prefilter: the bbox (or exact radius) lookup runs on the
    // generated `geog` point, then Prisma hydrates only the matched ids.
    const matchedIds = await this.spatialCandidateIds(lat, lng, radiusMeters, bounds)
    if (matchedIds.length === 0) return []

    const facilities = await this.prisma.facility.findMany({
      where: {
        id: { in: matchedIds },
        ...(vehicleType ? { vehicleTypes: { has: vehicleType } } : {}),
      },
      include: {
        images: { orderBy: { sortOrder: 'asc' }, take: 1 },
        promotionPlan: true,
      },
    })

    if (facilities.length === 0) return []

    const center = { lat, lng }
    const candidates = facilities.map((facility) => {
      const coords = { lat: facility.lat.toNumber(), lng: facility.lng.toNumber() }
      return { facility, coords, distanceMeters: computeDistanceMeters(center, coords) }
    })

    const ids = candidates.map((c) => c.facility.id)

    // Two set-based queries replace the former per-facility availability + price calls.
    const [overlapByFacility, priceByFacility] = await Promise.all([
      this.inventory.countOverlappingByFacility(ids, startsAt, endsAt),
      vehicleType
        ? this.tariff.computeTotalsByFacility(ids, startsAt, endsAt, vehicleType as never)
        : Promise.resolve(new Map<string, number>()),
    ])

    const results = candidates.map(({ facility, coords, distanceMeters }): FacilitySearchResult => {
      const free = facility.onlineQuota - (overlapByFacility.get(facility.id) ?? 0)
      const isPromoted =
        facility.promotionPlan?.isActive === true &&
        this.isPromotionLive(facility.promotionPlan.startsAt, facility.promotionPlan.endsAt)

      return {
        id: facility.id,
        name: facility.name,
        address: facility.address,
        lat: coords.lat,
        lng: coords.lng,
        distanceMeters: Math.round(distanceMeters),
        available: free > 0,
        remainingSlots: Math.max(0, free),
        priceCents: vehicleType ? (priceByFacility.get(facility.id) ?? null) : null,
        currency: 'EUR',
        isPromoted,
        rank: facility.rank,
        thumbnailUrl: facility.images[0]?.url ?? null,
      }
    })

    return this.rank(results, facilities)
  }

  /**
   * Facility ids whose location matches the search area, resolved by the GiST index
   * on the generated `geog` column. Bounds use an exact rectangle; otherwise an exact
   * radius (replacing the former lat/lng band scan + JS distance filter).
   */
  private async spatialCandidateIds(
    lat: number,
    lng: number,
    radiusMeters: number,
    bounds?: MapBounds,
  ): Promise<string[]> {
    const rows = bounds
      ? await this.prisma.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "Facility"
          WHERE "isActive" AND "isVerified"
            AND ST_Intersects(
              "geog",
              ST_MakeEnvelope(${bounds.west}, ${bounds.south}, ${bounds.east}, ${bounds.north}, 4326)::geography
            )`
      : await this.prisma.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "Facility"
          WHERE "isActive" AND "isVerified"
            AND ST_DWithin(
              "geog",
              ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography,
              ${radiusMeters}
            )`
    return rows.map((r) => r.id)
  }

  async getDetail(id: string) {
    const facility = await this.prisma.facility.findFirst({
      where: { id, isActive: true, isVerified: true },
      include: {
        images: { orderBy: { sortOrder: 'asc' } },
        rules: true,
        tariffPlans: {
          where: { isActive: true },
          include: { rules: { orderBy: { sortOrder: 'asc' } } },
        },
      },
    })

    if (!facility) throw new FacilityNotFoundError(id)

    const ratingAgg = await this.prisma.review.aggregate({
      where: { facilityId: id },
      _avg: { rating: true },
      _count: true,
    })

    return {
      ...facility,
      lat: facility.lat.toNumber(),
      lng: facility.lng.toNumber(),
      rating: {
        average: ratingAgg._avg.rating ?? null,
        count: ratingAgg._count,
      },
    }
  }

  async getQuote(facilityId: string, startsAt: Date, endsAt: Date, vehicleType: string) {
    return this.tariff.computeQuote({
      facilityId,
      startsAt,
      endsAt,
      vehicleType: vehicleType as never,
    })
  }

  private isPromotionLive(startsAt: Date | null, endsAt: Date | null): boolean {
    const now = new Date()
    if (startsAt && startsAt > now) return false
    if (endsAt && endsAt < now) return false
    return true
  }

  private rank(
    results: FacilitySearchResult[],
    facilities: Array<{ id: string; promotionPlan: { type: PromotionType } | null }>,
  ): FacilitySearchResult[] {
    const weightById = new Map(
      facilities.map((f) => [f.id, f.promotionPlan ? PROMOTION_WEIGHT[f.promotionPlan.type] : 0]),
    )

    return results.sort((a, b) => {
      if (a.rank !== b.rank) return b.rank - a.rank

      const wA = a.isPromoted ? (weightById.get(a.id) ?? 0) : 0
      const wB = b.isPromoted ? (weightById.get(b.id) ?? 0) : 0
      if (wA !== wB) return wB - wA

      if (a.priceCents != null && b.priceCents != null && a.priceCents !== b.priceCents) {
        return a.priceCents - b.priceCents
      }
      return a.distanceMeters - b.distanceMeters
    })
  }
}
