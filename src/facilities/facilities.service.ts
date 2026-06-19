import { Injectable } from '@nestjs/common'
import { computeDistanceMeters } from '@spark/maps'
import type { OpeningHours, VehicleType as ContractVehicleType } from '@spark/types'
import { Prisma, PromotionType, VehicleType } from '@prisma/client'
import type { AuthUser } from '@spark/types'
import { OperatorScopeService, type OperatorScope } from '../common/authz/operator-scope.service'
import {
  DomainError,
  FacilityFieldForbiddenError,
  FacilityNotFoundError,
} from '../common/errors/domain.errors'
import { InventoryService } from '../inventory/inventory.service'
import { PrismaService } from '../prisma/prisma.service'
import { TariffService } from '../tariff/tariff.service'
import type {
  CreateFacilityDto,
  ListFacilitiesDto,
  UpdateFacilityDto,
} from './dto/facility.dto'
import type {
  AdminFacility,
  AdminFacilityList,
  AdminFacilityListItem,
  FacilitySearchParams,
  FacilitySearchResult,
  MapBounds,
} from './facilities.types'

const VEHICLE_TO_PRISMA: Record<ContractVehicleType, VehicleType> = {
  car: VehicleType.CAR,
  motorcycle: VehicleType.MOTORCYCLE,
  van: VehicleType.VAN,
  truck: VehicleType.TRUCK,
}

const VEHICLE_FROM_PRISMA: Record<VehicleType, ContractVehicleType> = {
  [VehicleType.CAR]: 'car',
  [VehicleType.MOTORCYCLE]: 'motorcycle',
  [VehicleType.VAN]: 'van',
  [VehicleType.TRUCK]: 'truck',
}

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
    private readonly operatorScope: OperatorScopeService,
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
          include: {
            tiers: {
              orderBy: { fromMinute: 'asc' },
              include: { rates: true },
            },
            windows: true,
            caps: true,
          },
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

  async adminList(user: AuthUser, query: ListFacilitiesDto): Promise<AdminFacilityList> {
    const scope = await this.operatorScope.resolve(user)
    const where = this.adminListWhere(scope, query)

    const [rows, total] = await Promise.all([
      this.prisma.facility.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.take,
        select: {
          id: true,
          name: true,
          address: true,
          totalCapacity: true,
          onlineQuota: true,
          isActive: true,
          isVerified: true,
          operatorId: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      this.prisma.facility.count({ where }),
    ])

    const items: AdminFacilityListItem[] = rows.map((r) => ({ ...r }))
    return { items, total, skip: query.skip, take: query.take }
  }

  async adminGetById(user: AuthUser, id: string): Promise<AdminFacility> {
    const scope = await this.operatorScope.resolve(user)
    const facility = await this.prisma.facility.findFirst({
      where: { id, ...this.operatorScope.scopeWhere(scope) },
    })
    if (!facility) throw new FacilityNotFoundError(id)
    return this.toAdminFacility(facility)
  }

  async create(user: AuthUser, dto: CreateFacilityDto): Promise<AdminFacility> {
    const scope = await this.operatorScope.resolve(user)

    const operatorId =
      scope.kind === 'platform' ? dto.operatorId : scope.operatorId
    if (!operatorId) throw new DomainError('operatorId required')

    const operator = await this.prisma.parkingOperator.findUnique({
      where: { id: operatorId },
      select: { id: true },
    })
    if (!operator) throw new DomainError('operatorId required')

    const created = await this.prisma.$transaction(async (tx) => {
      // `geog` is a GENERATED ALWAYS column; the database derives it from lat/lng,
      // so no raw write is needed (and one would be rejected by Postgres).
      const facility = await tx.facility.create({
        data: {
          operatorId,
          name: dto.name,
          address: dto.address,
          lat: new Prisma.Decimal(dto.lat),
          lng: new Prisma.Decimal(dto.lng),
          totalCapacity: dto.totalCapacity,
          onlineQuota: dto.onlineQuota,
          vehicleTypes: dto.vehicleTypes.map((v) => VEHICLE_TO_PRISMA[v]),
          heightRestrictionCm: dto.heightRestrictionCm ?? null,
          openingHoursJson: dto.openingHours as unknown as Prisma.InputJsonValue,
          amenities: dto.amenities,
          cancellationPolicy: dto.cancellationPolicy,
          isActive: false,
          isVerified: false,
          rank: 0,
        },
      })

      await tx.auditLog.create({
        data: {
          actorId: user.id,
          actorRole: user.role,
          action: 'facility.created',
          entityType: 'Facility',
          entityId: facility.id,
        },
      })

      return facility
    })

    return this.toAdminFacility(created)
  }

  async update(user: AuthUser, id: string, dto: UpdateFacilityDto): Promise<AdminFacility> {
    const scope = await this.operatorScope.resolve(user)
    const existing = await this.prisma.facility.findFirst({
      where: { id, ...this.operatorScope.scopeWhere(scope) },
      select: { id: true },
    })
    if (!existing) throw new FacilityNotFoundError(id)

    if (scope.kind === 'operator') {
      if (dto.isVerified !== undefined) throw new FacilityFieldForbiddenError('isVerified')
      if (dto.rank !== undefined) throw new FacilityFieldForbiddenError('rank')
    }

    const data: Prisma.FacilityUpdateInput = {}
    if (dto.name !== undefined) data.name = dto.name
    if (dto.address !== undefined) data.address = dto.address
    if (dto.lat !== undefined) data.lat = new Prisma.Decimal(dto.lat)
    if (dto.lng !== undefined) data.lng = new Prisma.Decimal(dto.lng)
    if (dto.totalCapacity !== undefined) data.totalCapacity = dto.totalCapacity
    if (dto.onlineQuota !== undefined) data.onlineQuota = dto.onlineQuota
    if (dto.vehicleTypes !== undefined) {
      data.vehicleTypes = dto.vehicleTypes.map((v) => VEHICLE_TO_PRISMA[v])
    }
    if (dto.heightRestrictionCm !== undefined) data.heightRestrictionCm = dto.heightRestrictionCm
    if (dto.openingHours !== undefined) {
      data.openingHoursJson = dto.openingHours as unknown as Prisma.InputJsonValue
    }
    if (dto.amenities !== undefined) data.amenities = dto.amenities
    if (dto.cancellationPolicy !== undefined) data.cancellationPolicy = dto.cancellationPolicy
    if (dto.isActive !== undefined) data.isActive = dto.isActive
    if (dto.isVerified !== undefined) data.isVerified = dto.isVerified
    if (dto.rank !== undefined) data.rank = dto.rank

    const updated = await this.prisma.$transaction(async (tx) => {
      // `geog` regenerates automatically when lat/lng change (GENERATED ALWAYS column).
      const facility = await tx.facility.update({ where: { id }, data })

      await tx.auditLog.create({
        data: {
          actorId: user.id,
          actorRole: user.role,
          action: 'facility.updated',
          entityType: 'Facility',
          entityId: id,
        },
      })

      return facility
    })

    return this.toAdminFacility(updated)
  }

  async softDelete(user: AuthUser, id: string): Promise<void> {
    const scope = await this.operatorScope.resolve(user)
    const existing = await this.prisma.facility.findFirst({
      where: { id, ...this.operatorScope.scopeWhere(scope) },
      select: { id: true },
    })
    if (!existing) throw new FacilityNotFoundError(id)

    await this.prisma.$transaction(async (tx) => {
      await tx.facility.update({ where: { id }, data: { isActive: false } })
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          actorRole: user.role,
          action: 'facility.deactivated',
          entityType: 'Facility',
          entityId: id,
        },
      })
    })
  }

  private adminListWhere(scope: OperatorScope, query: ListFacilitiesDto): Prisma.FacilityWhereInput {
    const filters: Prisma.FacilityWhereInput[] = []
    if (query.q) {
      filters.push({
        OR: [
          { name: { contains: query.q, mode: 'insensitive' } },
          { address: { contains: query.q, mode: 'insensitive' } },
        ],
      })
    }
    if (query.isActive !== undefined) filters.push({ isActive: query.isActive })
    if (query.isVerified !== undefined) filters.push({ isVerified: query.isVerified })
    if (scope.kind === 'platform' && query.operatorId) {
      filters.push({ operatorId: query.operatorId })
    }

    return { ...this.operatorScope.scopeWhere(scope), ...(filters.length ? { AND: filters } : {}) }
  }

  private toAdminFacility(facility: {
    id: string
    operatorId: string
    name: string
    address: string
    lat: Prisma.Decimal
    lng: Prisma.Decimal
    totalCapacity: number
    onlineQuota: number
    vehicleTypes: VehicleType[]
    heightRestrictionCm: number | null
    openingHoursJson: Prisma.JsonValue
    amenities: string[]
    cancellationPolicy: string
    isActive: boolean
    isVerified: boolean
    rank: number
    createdAt: Date
    updatedAt: Date
  }): AdminFacility {
    return {
      id: facility.id,
      operatorId: facility.operatorId,
      name: facility.name,
      address: facility.address,
      lat: facility.lat.toNumber(),
      lng: facility.lng.toNumber(),
      totalCapacity: facility.totalCapacity,
      onlineQuota: facility.onlineQuota,
      vehicleTypes: facility.vehicleTypes.map((v) => VEHICLE_FROM_PRISMA[v]),
      heightRestrictionCm: facility.heightRestrictionCm,
      openingHours: facility.openingHoursJson as unknown as OpeningHours,
      amenities: facility.amenities,
      cancellationPolicy: facility.cancellationPolicy,
      isActive: facility.isActive,
      isVerified: facility.isVerified,
      rank: facility.rank,
      createdAt: facility.createdAt,
      updatedAt: facility.updatedAt,
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
