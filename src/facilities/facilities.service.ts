import { Injectable, Logger } from '@nestjs/common'
import { computeDistanceMeters } from '@spark/maps'
import type { OpeningHours, VehicleType as ContractVehicleType } from '@spark/types'
import {
  BookingStatus,
  FacilityKind,
  LifecycleStatus,
  Prisma,
  PromotionType,
  VehicleType,
} from '@prisma/client'
import type { AuthUser } from '@spark/types'
import { BookingService } from '../booking/booking.service'
import {
  OperatorScopeService,
  targetOperatorId,
  type OperatorScope,
  type OperatorScopeWhere,
} from '../common/authz/operator-scope.service'
import {
  DomainError,
  FacilityAlreadyExistsError,
  FacilityDeactivationFailedError,
  FacilityFieldForbiddenError,
  FacilityHasActiveBookingsError,
  FacilityNotFoundError,
  TariffAssignmentMismatchError,
  TariffPlanNotFoundError,
} from '../common/errors/domain.errors'
import { InventoryService } from '../inventory/inventory.service'
import { PrismaService } from '../prisma/prisma.service'
import { TariffService, assignmentMismatchReason } from '../tariff/tariff.service'
import type {
  BulkFacilityDto,
  CreateFacilityDto,
  ListFacilitiesDto,
  UpdateFacilityDto,
} from './dto/facility.dto'
import type {
  AdminFacility,
  AdminFacilityList,
  AdminFacilityListItem,
  AdminMapParams,
  AdminMapPoint,
  AdminMapResponse,
  BulkFacilityAction,
  BulkFacilityResult,
  BulkFacilitySkipped,
  FacilityCluster,
  FacilitySearchParams,
  FacilitySearchResponse,
  FacilitySearchResult,
  FacilityTariffAssignments,
  MapBounds,
  ResolvedTariffAssignment,
} from './facilities.types'

const MAX_POINTS = 250
const CLUSTER_COLS = 12
const CLUSTER_ROWS = 12

// Bookings a deactivation would abandon: still to be honoured (CONFIRMED) or with a
// vehicle currently inside (CHECKED_IN), and not yet over. Everything else is history.
const UNHONOURED_BOOKING_STATUSES = [BookingStatus.CONFIRMED, BookingStatus.CHECKED_IN]

// Shared with LifecycleService: archiving or tombstoning a facility must refuse for
// exactly the same reason deactivating one does.
export function unhonouredBookingsWhere(facilityId: string | string[]): Prisma.BookingWhereInput {
  return {
    facilityId: Array.isArray(facilityId) ? { in: facilityId } : facilityId,
    status: { in: UNHONOURED_BOOKING_STATUSES },
    endsAt: { gt: new Date() },
  }
}

// Public visibility gate, shared by every public search query so the count, the point
// prefilter and the cluster buckets can never disagree about what is publicly listable.
// The lifecycle term is load-bearing: these queries run as raw SQL, which the default
// lifecycle filter (src/prisma/lifecycle.extension.ts) cannot intercept.
const PUBLIC_VISIBLE_SQL = Prisma.sql`"isActive" AND "isVerified" AND "kind" != 'RESTRICTED' AND "lifecycleStatus" = 'ACTIVE'`

/**
 * One admin-map filter term, expressed as data so it can be rendered twice: as Prisma
 * `where` input for the points path and as a parameterised SQL fragment for the count and
 * cluster paths. Adding a variant breaks compilation of both translators below (a switch
 * with no default cannot fall through under strictNullChecks), which is what keeps the
 * two renderings from drifting — a drift would make cluster counts contradict the points.
 */
type AdminMapFilter =
  | { on: 'bounds'; bounds: MapBounds }
  | { on: 'text'; value: string }
  | { on: 'isActive'; value: boolean }
  | { on: 'isVerified'; value: boolean }
  | { on: 'kind'; value: FacilityKind }
  | { on: 'operators'; value: string[] }
  | { on: 'lifecycle'; value: LifecycleStatus }

function adminFilterWhere(filter: AdminMapFilter): Prisma.FacilityWhereInput {
  switch (filter.on) {
    case 'bounds':
      return {
        lat: { gte: filter.bounds.south, lte: filter.bounds.north },
        lng: { gte: filter.bounds.west, lte: filter.bounds.east },
      }
    case 'text':
      return {
        OR: [
          { name: { contains: filter.value, mode: 'insensitive' } },
          { address: { contains: filter.value, mode: 'insensitive' } },
        ],
      }
    case 'isActive':
      return { isActive: filter.value }
    case 'isVerified':
      return { isVerified: filter.value }
    case 'kind':
      return { kind: filter.value }
    case 'operators':
      return { operatorId: { in: filter.value } }
    case 'lifecycle':
      return { lifecycleStatus: filter.value }
  }
}

function adminFilterSql(filter: AdminMapFilter): Prisma.Sql {
  switch (filter.on) {
    case 'bounds':
      return Prisma.sql`ST_Intersects("geog", ST_MakeEnvelope(${filter.bounds.west}, ${filter.bounds.south}, ${filter.bounds.east}, ${filter.bounds.north}, 4326)::geography)`
    case 'text':
      // Wildcards inside the bound value stay unescaped on purpose: Prisma's `contains`
      // does the same, and matching it is what keeps the points path in step.
      return Prisma.sql`("name" ILIKE ${`%${filter.value}%`} OR "address" ILIKE ${`%${filter.value}%`})`
    case 'isActive':
      return Prisma.sql`"isActive" = ${filter.value}`
    case 'isVerified':
      return Prisma.sql`"isVerified" = ${filter.value}`
    case 'kind':
      return Prisma.sql`"kind" = ${filter.value}::"FacilityKind"`
    case 'operators':
      return Prisma.sql`"operatorId" IN (${Prisma.join(filter.value)})`
    case 'lifecycle':
      return Prisma.sql`"lifecycleStatus" = ${filter.value}::"LifecycleStatus"`
  }
}

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
  private readonly logger = new Logger(FacilitiesService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly tariff: TariffService,
    private readonly operatorScope: OperatorScopeService,
    private readonly bookings: BookingService,
  ) {}

  async search(params: FacilitySearchParams): Promise<FacilitySearchResponse> {
    const { bounds } = params
    const whereSql = this.searchWhereSql(params)

    const total = await this.countFacilities(whereSql)

    if (bounds && total > MAX_POINTS) {
      const clusters = await this.gridClusters(whereSql, bounds)
      return { mode: 'clusters', points: [], clusters, total }
    }

    const points = await this.searchPoints(params)
    return { mode: 'points', points, clusters: [], total }
  }

  private async searchPoints(params: FacilitySearchParams): Promise<FacilitySearchResult[]> {
    const { lat, lng, startsAt, endsAt, vehicleType } = params

    // GiST-indexed spatial prefilter: the bbox (or exact radius) lookup runs on the
    // generated `geog` point, then Prisma hydrates only the matched ids.
    const matchedIds = await this.spatialCandidateIds(params)
    if (matchedIds.length === 0) return []

    const facilities = await this.prisma.facility.findMany({
      where: { id: { in: matchedIds } },
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
        kind: facility.kind,
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
   * The one predicate every public search query runs on: visibility, the spatial area
   * (exact rectangle when bounds are given, otherwise exact radius) and the vehicle-class
   * filter. Sharing it is what makes `total` describe exactly the set the points path
   * returns — counting without the vehicle filter used to overstate it and could flip the
   * response into cluster mode on a set that fits in `MAX_POINTS`.
   */
  private searchWhereSql(params: {
    lat: number
    lng: number
    radiusMeters: number
    bounds?: MapBounds
    vehicleType?: VehicleType
  }): Prisma.Sql {
    const { lat, lng, radiusMeters, bounds, vehicleType } = params

    const spatial = bounds
      ? Prisma.sql`ST_Intersects("geog", ST_MakeEnvelope(${bounds.west}, ${bounds.south}, ${bounds.east}, ${bounds.north}, 4326)::geography)`
      : Prisma.sql`ST_DWithin("geog", ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography, ${radiusMeters})`

    const vehicle = vehicleType
      ? Prisma.sql`AND ${vehicleType}::"VehicleType" = ANY("vehicleTypes")`
      : Prisma.empty

    return Prisma.sql`${PUBLIC_VISIBLE_SQL} AND ${spatial} ${vehicle}`
  }

  /**
   * Facility ids matching the search predicate, resolved by the GiST index on the
   * generated `geog` column.
   */
  private async spatialCandidateIds(params: FacilitySearchParams): Promise<string[]> {
    const { lat, lng, bounds } = params

    const nearestFirst = bounds
      ? Prisma.empty
      : Prisma.sql`ORDER BY "geog" <-> ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography`

    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Facility"
      WHERE ${this.searchWhereSql(params)}
      ${nearestFirst}
      LIMIT ${MAX_POINTS}`
    return rows.map((r) => r.id)
  }

  /**
   * Cheap count behind a predicate, so points-vs-clusters can be decided without
   * hydrating any rows.
   */
  private async countFacilities(where: Prisma.Sql): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM "Facility"
      WHERE ${where}`
    return rows[0]?.count ?? 0
  }

  /**
   * Aggregates the facilities matching `where` into a fixed 12x12 grid of the visible
   * rectangle. The bucketing runs in SQL over the GiST-indexed `geog` column: a zoomed-out
   * view can match the whole ingested dataset, which must never be hydrated into memory.
   */
  private async gridClusters(where: Prisma.Sql, bounds: MapBounds): Promise<FacilityCluster[]> {
    const cellLng = (bounds.east - bounds.west) / CLUSTER_COLS
    const cellLat = (bounds.north - bounds.south) / CLUSTER_ROWS

    const rows = await this.prisma.$queryRaw<
      Array<{ gx: number; gy: number; count: number; lat: number; lng: number }>
    >`
      SELECT
        floor((ST_X(g) - ${bounds.west}) / ${cellLng})::int AS gx,
        floor((ST_Y(g) - ${bounds.south}) / ${cellLat})::int AS gy,
        count(*)::int AS count,
        avg(ST_Y(g)) AS lat,
        avg(ST_X(g)) AS lng
      FROM (
        SELECT "geog"::geometry AS g FROM "Facility" WHERE ${where}
      ) s
      GROUP BY gx, gy`

    return rows.map((r) => ({
      id: `c_${r.gx}_${r.gy}`,
      lat: Number(r.lat),
      lng: Number(r.lng),
      count: r.count,
    }))
  }

  async getDetail(id: string) {
    const facility = await this.prisma.facility.findFirst({
      where: { id, isActive: true, isVerified: true, kind: { not: FacilityKind.RESTRICTED } },
      include: {
        images: { orderBy: { sortOrder: 'asc' } },
        rules: true,
        tariffAssignments: {
          include: {
            tariffPlan: {
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
        },
      },
    })

    if (!facility) throw new FacilityNotFoundError(id)

    const ratingAgg = await this.prisma.review.aggregate({
      where: { facilityId: id },
      _avg: { rating: true },
      _count: true,
    })

    // Public facility read: returns only explicit per-vehicle-type rows (no operator-default
    // resolution — that belongs to the editor UI's getTariffAssignments). Assignment and
    // activation are independent: a plan can be deactivated while still assigned, so null
    // out an assigned-but-inactive plan per row so a dead plan is never shown as live pricing.
    // The lifecycle check is not redundant: the plan arrives through a nested include,
    // which the default lifecycle filter does not intercept.
    const { tariffAssignments, ...rest } = facility
    const assignments = tariffAssignments.map((a) => ({
      ...a,
      tariffPlan:
        a.tariffPlan.isActive && a.tariffPlan.lifecycleStatus === LifecycleStatus.ACTIVE
          ? a.tariffPlan
          : null,
    }))

    return {
      ...rest,
      tariffAssignments: assignments,
      lat: facility.lat.toNumber(),
      lng: facility.lng.toNumber(),
      rating: {
        average: ratingAgg._avg.rating ?? null,
        count: ratingAgg._count,
      },
    }
  }

  /**
   * Sets or clears ONE assignment row for a facility's concrete `(vehicleType)` slot. Both
   * the facility and — when assigning — the plan must belong to the caller's operator scope;
   * checking only one side would let an operator assign another operator's private plan to
   * their facility (pricing leak), or point their plan at a foreign facility. The plan's
   * own `vehicleTypes` must not contradict the target slot. Delete-then-create (not upsert)
   * works around the Prisma compound whereUnique gotcha.
   */
  async assignTariff(
    user: AuthUser,
    facilityId: string,
    vehicleType: VehicleType,
    tariffPlanId: string | null,
  ): Promise<{ facilityId: string; vehicleType: VehicleType; tariffPlanId: string | null }> {
    const scope = await this.operatorScope.resolve(user)
    const scopeWhere = this.operatorScope.scopeWhere(scope)

    const facility = await this.prisma.facility.findFirst({
      where: { id: facilityId, ...scopeWhere },
      select: { id: true },
    })
    if (!facility) throw new FacilityNotFoundError(facilityId)

    if (tariffPlanId !== null) {
      const plan = await this.prisma.tariffPlan.findFirst({
        where: { id: tariffPlanId, ...scopeWhere },
        select: { id: true, vehicleTypes: true },
      })
      if (!plan) throw new TariffPlanNotFoundError(tariffPlanId)

      const mismatch = assignmentMismatchReason(plan.vehicleTypes, vehicleType)
      if (mismatch) throw new TariffAssignmentMismatchError(mismatch)
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.facilityTariffAssignment.deleteMany({ where: { facilityId, vehicleType } })
      if (tariffPlanId !== null) {
        await tx.facilityTariffAssignment.create({
          data: { facilityId, tariffPlanId, vehicleType },
        })
      }
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          actorRole: user.role,
          action: tariffPlanId ? 'facility.tariff_assigned' : 'facility.tariff_unassigned',
          entityType: 'Facility',
          entityId: facilityId,
          payload: { vehicleType, tariffPlanId },
        },
      })
    })

    return { facilityId, vehicleType, tariffPlanId }
  }

  /**
   * The RESOLVED tariff per vehicle type for one facility: for each of the 4 vehicle types,
   * the facility's explicit row when present, else the operator's active default plan, else
   * nothing. Same facility-ownership check as other facility-scoped admin reads. Gives the
   * editor UI an honest picture including implicit default coverage.
   */
  async getTariffAssignments(
    user: AuthUser,
    facilityId: string,
  ): Promise<FacilityTariffAssignments> {
    const scope = await this.operatorScope.resolve(user)
    const facility = await this.prisma.facility.findFirst({
      where: { id: facilityId, ...this.operatorScope.scopeWhere(scope) },
      select: { id: true, operatorId: true },
    })
    if (!facility) throw new FacilityNotFoundError(facilityId)

    const [rows, defaultPlan] = await Promise.all([
      this.prisma.facilityTariffAssignment.findMany({
        where: { facilityId },
        select: { vehicleType: true, tariffPlanId: true, tariffPlan: { select: { name: true } } },
      }),
      this.prisma.tariffPlan.findFirst({
        where: { operatorId: facility.operatorId, isDefault: true, isActive: true },
        select: { id: true, name: true },
      }),
    ])

    const explicitByType = new Map(rows.map((r) => [r.vehicleType, r]))

    const assignments: ResolvedTariffAssignment[] = Object.values(VehicleType).map((vt) => {
      const explicit = explicitByType.get(vt)
      if (explicit) {
        return {
          vehicleType: vt,
          tariffPlanId: explicit.tariffPlanId,
          tariffPlanName: explicit.tariffPlan.name,
          source: 'explicit',
        }
      }
      if (defaultPlan) {
        return {
          vehicleType: vt,
          tariffPlanId: defaultPlan.id,
          tariffPlanName: defaultPlan.name,
          source: 'default',
        }
      }
      return { vehicleType: vt, tariffPlanId: null, tariffPlanName: null, source: 'none' }
    })

    return {
      assignments,
      defaultPlan: defaultPlan ? { id: defaultPlan.id, name: defaultPlan.name } : null,
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
          kind: true,
          source: true,
          operatorId: true,
          operator: { select: { name: true } },
          createdAt: true,
          updatedAt: true,
        },
      }),
      this.prisma.facility.count({ where }),
    ])

    const items: AdminFacilityListItem[] = rows.map(({ operator, ...r }) => ({
      ...r,
      operatorName: operator.name,
    }))
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

    const operatorId = targetOperatorId(scope, dto.operatorId)

    const operator = await this.prisma.parkingOperator.findUnique({
      where: { id: operatorId },
      select: { id: true },
    })
    if (!operator) throw new DomainError('operatorId required')

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        // Lock the operator row so two concurrent creates serialize on the same
        // operator, then enforce the one-facility-per-operator cap under that lock.
        await tx.$executeRaw`SELECT id FROM "ParkingOperator" WHERE id = ${operatorId} FOR UPDATE`

        const existing = await tx.facility.count({ where: { operatorId } })
        if (existing >= 1) throw new FacilityAlreadyExistsError(operatorId)

        // `geog` is a GENERATED ALWAYS column; the database derives it from lat/lng,
        // so no raw write is needed (and one would be rejected by Postgres).
        const facility = await tx.facility.create({
          data: {
            operatorId,
            kind: FacilityKind.BUSINESS,
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

        // Analytics attributes money through FacilityOwnershipPeriod, never through
        // Facility.operatorId, and the attribution join is an inner one: a facility with no
        // open period earns revenue that no report can see. Same transaction as the insert,
        // so a facility can never exist without one.
        await tx.facilityOwnershipPeriod.create({
          data: { facilityId: facility.id, operatorId, from: facility.createdAt, to: null },
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
    } catch (error) {
      // Belt-and-suspenders: if two requests both pass the count check before either
      // commits, the unique index on Facility.operatorId rejects the loser with P2002.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new FacilityAlreadyExistsError(operatorId)
      }
      throw error
    }
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

    // Same invariant the delete path enforces — an edit must not be a side door around
    // it. No force here on purpose: shutting a facility down with live bookings is a
    // deliberate act with refunds attached, so it goes through DELETE ?force=true.
    if (dto.isActive === false) {
      const unhonoured = await this.prisma.booking.count({ where: this.unhonouredWhere(id) })
      if (unhonoured > 0) throw new FacilityHasActiveBookingsError(id, unhonoured)
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

  /**
   * Deactivates a facility, refusing while it still owes customers a place to park.
   * Deactivation used to be a bare `isActive = false`, which left every future booking
   * pointing at a facility that no longer operates: holdSlot blocks NEW bookings there,
   * but the ones already paid for were simply abandoned.
   *
   * `force` is the escape hatch, and it pays its way out: every unhonoured booking is
   * cancelled and refunded through BookingService.cancelBooking — the existing two-phase
   * path, so a provider failure leaves REFUND_PENDING plus a retryable Refund row rather
   * than a second, divergent refund implementation. If any cancellation fails the
   * facility stays ACTIVE and the error names what did and did not happen; the bookings
   * already refunded no longer block, so a retry resumes where this one stopped.
   */
  async softDelete(user: AuthUser, id: string, force = false): Promise<void> {
    const scope = await this.operatorScope.resolve(user)
    const existing = await this.prisma.facility.findFirst({
      where: { id, ...this.operatorScope.scopeWhere(scope) },
      select: { id: true },
    })
    if (!existing) throw new FacilityNotFoundError(id)

    const unhonoured = await this.prisma.booking.findMany({
      where: this.unhonouredWhere(id),
      select: { id: true },
    })

    let cancelled = 0
    if (unhonoured.length > 0) {
      if (!force) throw new FacilityHasActiveBookingsError(id, unhonoured.length)

      const outcome = await this.cancelAndRefund(
        user,
        unhonoured.map((b) => b.id),
      )
      cancelled = outcome.cancelled
      if (outcome.failed > 0) {
        throw new FacilityDeactivationFailedError(id, outcome.cancelled, outcome.failed)
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.facility.update({ where: { id }, data: { isActive: false } })
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          actorRole: user.role,
          action: 'facility.deactivated',
          entityType: 'Facility',
          entityId: id,
          payload: { forced: force, cancelledBookings: cancelled },
        },
      })
    })
  }

  // Bookings that a deactivation would strand: not yet finished, and either paid and
  // waiting (CONFIRMED) or with the vehicle already inside (CHECKED_IN).
  private unhonouredWhere(facilityId: string | string[]): Prisma.BookingWhereInput {
    return unhonouredBookingsWhere(facilityId)
  }

  /**
   * Cancels and refunds a batch through the one refund implementation there is. Strictly
   * sequential: each cancellation calls the payment provider, and a parallel fan-out
   * would both hammer it and make a partial failure impossible to describe. A failure is
   * recorded and the loop continues, so the caller learns the true split instead of
   * stopping at the first bad one and leaving the rest unexamined.
   */
  private async cancelAndRefund(
    user: AuthUser,
    bookingIds: string[],
  ): Promise<{ cancelled: number; failed: number }> {
    let cancelled = 0
    let failed = 0

    for (const bookingId of bookingIds) {
      try {
        await this.bookings.cancelBooking(bookingId, user)
        cancelled++
      } catch (error) {
        failed++
        this.logger.error(
          `Forced facility deactivation could not cancel booking ${bookingId}`,
          error instanceof Error ? error.stack : String(error),
        )
      }
    }

    return { cancelled, failed }
  }

  async bulkUpdate(user: AuthUser, dto: BulkFacilityDto): Promise<BulkFacilityResult> {
    const scope = await this.operatorScope.resolve(user)
    const scopeWhere = this.operatorScope.scopeWhere(scope)

    // Verification is platform-only; operators cannot self-verify (mirrors `update`).
    if (dto.action === 'deploy' && scope.kind === 'operator') {
      throw new FacilityFieldForbiddenError('isVerified')
    }

    // assignTariff carries a dynamic per-slot payload and its own multi-plan ownership
    // check, so it can't route through the static bulkData / single-updateMany path.
    if (dto.action === 'assignTariff') {
      return this.bulkAssignTariff(user, dto.ids, dto.assignments, scopeWhere)
    }

    // Deactivation is per-facility (each has its own bookings to honour or refund), so it
    // cannot be one updateMany over the whole selection.
    if (dto.action === 'disable' || dto.action === 'delete') {
      return this.bulkDeactivate(user, dto.action, dto.ids, scopeWhere, dto.force)
    }

    return this.runBulk(user, dto.action, dto.ids, scopeWhere, this.bulkData(dto.action))
  }

  /**
   * Bulk deactivation, decided facility by facility. The old single `updateMany` flipped
   * every selected row regardless of what was booked there; a per-facility loop is the
   * price of the guard.
   *
   * Honesty is the design constraint. A facility is deactivated only when it owes
   * nothing, or when `force` cancelled and refunded everything it owed. Anything else is
   * left ACTIVE and reported in `skipped` with its counts, so a partial force — three
   * facilities cleared, the fourth stuck on a provider failure after refunding two of its
   * five bookings — reads as exactly that rather than as a silent success. The call does
   * not throw: the other facilities genuinely were deactivated, and rolling that back
   * would mean un-refunding money.
   */
  private async bulkDeactivate(
    user: AuthUser,
    action: 'disable' | 'delete',
    ids: string[],
    scopeWhere: OperatorScopeWhere,
    force: boolean,
  ): Promise<BulkFacilityResult> {
    // ids are only a filter — scopeWhere is the authorization boundary, so an operator
    // passing foreign ids simply deactivates none of them.
    const scoped = await this.prisma.facility.findMany({
      where: { id: { in: ids }, ...scopeWhere },
      select: { id: true },
    })
    const scopedIds = scoped.map((f) => f.id)
    if (scopedIds.length === 0) return { affected: 0 }

    const grouped = await this.prisma.booking.groupBy({
      by: ['facilityId'],
      where: this.unhonouredWhere(scopedIds),
      _count: { _all: true },
    })
    const unhonouredByFacility = new Map(grouped.map((g) => [g.facilityId, g._count._all]))

    const clear: string[] = []
    const skipped: BulkFacilitySkipped[] = []

    for (const facilityId of scopedIds) {
      const unhonoured = unhonouredByFacility.get(facilityId) ?? 0
      if (unhonoured === 0) {
        clear.push(facilityId)
        continue
      }
      if (!force) {
        skipped.push({ facilityId, reason: 'unhonoured_bookings', unhonoured, cancelled: 0 })
        continue
      }

      const bookings = await this.prisma.booking.findMany({
        where: this.unhonouredWhere(facilityId),
        select: { id: true },
      })
      const outcome = await this.cancelAndRefund(
        user,
        bookings.map((b) => b.id),
      )
      if (outcome.failed > 0) {
        skipped.push({
          facilityId,
          reason: 'refund_failed',
          unhonoured: bookings.length,
          cancelled: outcome.cancelled,
        })
        continue
      }
      clear.push(facilityId)
    }

    const affected = await this.prisma.$transaction(async (tx) => {
      const result = clear.length
        ? await tx.facility.updateMany({
            where: { id: { in: clear }, ...scopeWhere },
            data: { isActive: false },
          })
        : { count: 0 }

      await tx.auditLog.create({
        data: {
          actorId: user.id,
          actorRole: user.role,
          action: `facility.bulk.${action}`,
          entityType: 'Facility',
          entityId: `${result.count} of ${ids.length}`,
          payload: { forced: force, skipped: skipped as unknown as Prisma.InputJsonValue },
        },
      })

      return result.count
    })

    return skipped.length > 0 ? { affected, skipped } : { affected }
  }

  /**
   * Bulk sets/clears assignment rows across many facilities and vehicle-type slots.
   *
   * Tenant safety: collect every DISTINCT non-null plan id across the whole assignments
   * array and verify EVERY one belongs to the caller's scope before any write — a naive
   * check of only the first pair would let an attacker smuggle a foreign plan in later
   * entries. Any out-of-scope plan rejects the whole call with no partial writes.
   *
   * The write is two set-based queries (not a loop over ids × assignments): one deleteMany
   * clearing each targeted slot on each scoped facility, then one createMany inserting the
   * non-null pairs. Facility ownership stays enforced via `scopeWhere`, so foreign ids are
   * silently excluded (matching the other bulk actions), not hard-errored.
   */
  private async bulkAssignTariff(
    user: AuthUser,
    ids: string[],
    assignments: { vehicleType: VehicleType; tariffPlanId: string | null }[],
    scopeWhere: OperatorScopeWhere,
  ): Promise<BulkFacilityResult> {
    const planIds = [
      ...new Set(assignments.map((a) => a.tariffPlanId).filter((id): id is string => id !== null)),
    ]

    if (planIds.length > 0) {
      const owned = await this.prisma.tariffPlan.findMany({
        where: { id: { in: planIds }, ...scopeWhere },
        select: { id: true, vehicleTypes: true },
      })
      const ownedById = new Map(owned.map((p) => [p.id, p.vehicleTypes]))

      for (const planId of planIds) {
        if (!ownedById.has(planId)) throw new TariffPlanNotFoundError(planId)
      }

      // Every non-null assignment's slot must be consistent with its plan's own vehicle types.
      for (const a of assignments) {
        if (a.tariffPlanId === null) continue
        const mismatch = assignmentMismatchReason(ownedById.get(a.tariffPlanId)!, a.vehicleType)
        if (mismatch) throw new TariffAssignmentMismatchError(mismatch)
      }
    }

    const slots = assignments.map((a) => a.vehicleType)

    const affected = await this.prisma.$transaction(async (tx) => {
      // Only in-scope facilities count as affected; ownership rides on the facility filter.
      const scoped = await tx.facility.findMany({
        where: { id: { in: ids }, ...scopeWhere },
        select: { id: true },
      })
      const scopedIds = scoped.map((f) => f.id)

      if (scopedIds.length > 0) {
        await tx.facilityTariffAssignment.deleteMany({
          where: { facilityId: { in: scopedIds }, vehicleType: { in: slots } },
        })

        const rows = scopedIds.flatMap((facilityId) =>
          assignments
            .filter((a) => a.tariffPlanId !== null)
            .map((a) => ({
              facilityId,
              tariffPlanId: a.tariffPlanId as string,
              vehicleType: a.vehicleType,
            })),
        )
        if (rows.length > 0) {
          await tx.facilityTariffAssignment.createMany({ data: rows })
        }
      }

      await tx.auditLog.create({
        data: {
          actorId: user.id,
          actorRole: user.role,
          action: 'facility.bulk.assignTariff',
          entityType: 'Facility',
          entityId: `${scopedIds.length} of ${ids.length}`,
        },
      })

      return scopedIds.length
    })

    return { affected }
  }

  private async runBulk(
    user: AuthUser,
    action: BulkFacilityAction,
    ids: string[],
    scopeWhere: OperatorScopeWhere,
    data: Prisma.FacilityUncheckedUpdateManyInput,
  ): Promise<BulkFacilityResult> {
    // ids are only a filter — scopeWhere is the authorization boundary, so an operator
    // passing foreign ids simply updates none of them.
    const where: Prisma.FacilityWhereInput = { id: { in: ids }, ...scopeWhere }

    const affected = await this.prisma.$transaction(async (tx) => {
      const result = await tx.facility.updateMany({ where, data })
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          actorRole: user.role,
          action: `facility.bulk.${action}`,
          entityType: 'Facility',
          entityId: `${result.count} of ${ids.length}`,
        },
      })
      return result.count
    })

    return { affected }
  }

  // disable/delete are absent by design: they route through bulkDeactivate, which has to
  // decide facility by facility rather than emit one blanket update.
  private bulkData(
    action: Exclude<BulkFacilityAction, 'assignTariff' | 'disable' | 'delete'>,
  ): Prisma.FacilityUpdateManyMutationInput {
    switch (action) {
      case 'deploy':
        return { isActive: true, isVerified: true }
      case 'enable':
        return { isActive: true }
      case 'publish':
        return { isVerified: true }
      case 'unpublish':
        return { isVerified: false }
    }
  }

  async adminMap(user: AuthUser, params: AdminMapParams): Promise<AdminMapResponse> {
    const scope = await this.operatorScope.resolve(user)
    const filters = this.adminMapFilters(scope, params)
    const whereSql = this.adminMapSql(filters)

    const total = await this.countFacilities(whereSql)
    if (total === 0) return { mode: 'points', points: [], clusters: [], total }

    if (total > MAX_POINTS) {
      const clusters = await this.gridClusters(whereSql, params.bounds)
      return { mode: 'clusters', points: [], clusters, total }
    }

    const rows = await this.prisma.facility.findMany({
      where: this.adminMapWhere(filters),
      select: {
        id: true,
        name: true,
        lat: true,
        lng: true,
        kind: true,
        isActive: true,
        isVerified: true,
      },
      take: MAX_POINTS,
    })

    const points: AdminMapPoint[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      lat: r.lat.toNumber(),
      lng: r.lng.toNumber(),
      kind: r.kind,
      isActive: r.isActive,
      isVerified: r.isVerified,
    }))
    return { mode: 'points', points, clusters: [], total }
  }

  /**
   * The admin map's filter set, resolved once per request. Operator scope stays sourced
   * from OperatorScopeService, so a caller's own memberships always win over a requested
   * `operatorId` — only a platform caller may narrow to an arbitrary operator.
   */
  private adminMapFilters(scope: OperatorScope, params: AdminMapParams): AdminMapFilter[] {
    // Lifecycle rides in the filter list so both renderings (Prisma where for points,
    // raw SQL for count/clusters) carry it — the SQL paths bypass the client extension.
    const filters: AdminMapFilter[] = [
      { on: 'bounds', bounds: params.bounds },
      { on: 'lifecycle', value: LifecycleStatus.ACTIVE },
    ]
    if (params.q) filters.push({ on: 'text', value: params.q })
    if (params.isActive !== undefined) filters.push({ on: 'isActive', value: params.isActive })
    if (params.isVerified !== undefined) {
      filters.push({ on: 'isVerified', value: params.isVerified })
    }
    if (params.kind) filters.push({ on: 'kind', value: params.kind })

    const scoped = this.operatorScope.scopeWhere(scope).operatorId?.in
    if (scoped) filters.push({ on: 'operators', value: scoped })
    else if (params.operatorId) filters.push({ on: 'operators', value: [params.operatorId] })

    return filters
  }

  private adminMapWhere(filters: AdminMapFilter[]): Prisma.FacilityWhereInput {
    return { AND: filters.map(adminFilterWhere) }
  }

  // Every user-supplied value rides as a bound parameter; nothing is interpolated as text.
  private adminMapSql(filters: AdminMapFilter[]): Prisma.Sql {
    return Prisma.join(filters.map(adminFilterSql), ' AND ')
  }

  private adminListWhere(
    scope: OperatorScope,
    query: ListFacilitiesDto,
  ): Prisma.FacilityWhereInput {
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
    if (query.kind) filters.push({ kind: query.kind })
    if (scope.kind === 'platform' && query.operatorId) {
      filters.push({ operatorId: query.operatorId })
    }

    return { ...this.operatorScope.scopeWhere(scope), ...(filters.length ? { AND: filters } : {}) }
  }

  private toAdminFacility(facility: {
    id: string
    operatorId: string
    kind: FacilityKind
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
      kind: facility.kind,
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
