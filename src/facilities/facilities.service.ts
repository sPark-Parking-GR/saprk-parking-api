import { Injectable } from '@nestjs/common'
import { computeDistanceMeters } from '@parqin/maps'
import { PromotionType, type Prisma } from '@prisma/client'
import { FacilityNotFoundError } from '../common/errors/domain.errors'
import { InventoryService } from '../inventory/inventory.service'
import { PrismaService } from '../prisma/prisma.service'
import { TariffService } from '../tariff/tariff.service'
import { DomainError } from '../common/errors/domain.errors'
import type { FacilitySearchParams, FacilitySearchResult } from './facilities.types'

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

    const latRange = bounds
      ? { gte: bounds.south, lte: bounds.north }
      : { gte: lat - (radiusMeters / 111_320) * 1.2, lte: lat + (radiusMeters / 111_320) * 1.2 }
    const lngRange = bounds
      ? { gte: bounds.west, lte: bounds.east }
      : {
          gte: lng - (radiusMeters / (111_320 * Math.cos((lat * Math.PI) / 180))) * 1.2,
          lte: lng + (radiusMeters / (111_320 * Math.cos((lat * Math.PI) / 180))) * 1.2,
        }

    const where: Prisma.FacilityWhereInput = {
      isActive: true,
      isVerified: true,
      lat: latRange,
      lng: lngRange,
      ...(vehicleType ? { vehicleTypes: { has: vehicleType } } : {}),
    }

    const facilities = await this.prisma.facility.findMany({
      where,
      include: {
        images: { orderBy: { sortOrder: 'asc' }, take: 1 },
        promotionPlan: true,
      },
    })

    const center = { lat, lng }

    const results = await Promise.all(
      facilities.map(async (facility): Promise<FacilitySearchResult | null> => {
        const coords = { lat: facility.lat.toNumber(), lng: facility.lng.toNumber() }
        const distanceMeters = computeDistanceMeters(center, coords)
        if (!bounds && distanceMeters > radiusMeters) return null

        const availability = await this.inventory.checkAvailability({
          facilityId: facility.id,
          startsAt,
          endsAt,
        })

        const priceCents = await this.computePriceOrNull(facility.id, startsAt, endsAt, vehicleType)

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
          available: availability.available,
          remainingSlots: availability.remainingSlots,
          priceCents,
          currency: 'EUR',
          isPromoted,
          thumbnailUrl: facility.images[0]?.url ?? null,
        }
      }),
    )

    return this.rank(results.filter((r): r is FacilitySearchResult => r !== null), facilities)
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

  private async computePriceOrNull(
    facilityId: string,
    startsAt: Date,
    endsAt: Date,
    vehicleType?: string,
  ): Promise<number | null> {
    if (!vehicleType) return null
    try {
      const quote = await this.tariff.computeQuote({
        facilityId,
        startsAt,
        endsAt,
        vehicleType: vehicleType as never,
      })
      return quote.totalCents
    } catch (error) {
      if (error instanceof DomainError) return null
      throw error
    }
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
