import { Injectable } from '@nestjs/common'
import { computeDistanceMeters } from '@spark/maps'
import type { OpeningHours, VehicleType as ContractVehicleType } from '@spark/types'
import { FacilityKind, Prisma, PromotionType, VehicleType } from '@prisma/client'
import type { AuthUser } from '@spark/types'
import { OperatorScopeService, type OperatorScope } from '../common/authz/operator-scope.service'
import {
  DomainError,
  FacilityAlreadyExistsError,
  FacilityFieldForbiddenError,
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
  FacilityCluster,
  FacilitySearchParams,
  FacilitySearchResponse,
  FacilitySearchResult,
  FacilityTariffAssignments,
  MapBounds,
  ResolvedTariffAssignment,
} from './facilities.types'

const MAX_POINTS = 250

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

  async search(params: FacilitySearchParams): Promise<FacilitySearchResponse> {
    const { lat, lng, radiusMeters, bounds } = params

    const total = await this.countInArea(lat, lng, radiusMeters, bounds)

    if (bounds && total > MAX_POINTS) {
      const clusters = await this.buildClusters(bounds)
      return { mode: 'clusters', points: [], clusters, total }
    }

    const points = await this.searchPoints(params)
    return { mode: 'points', points, clusters: [], total }
  }

  private async searchPoints(params: FacilitySearchParams): Promise<FacilitySearchResult[]> {
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
            AND "kind" != 'RESTRICTED'
            AND ST_Intersects(
              "geog",
              ST_MakeEnvelope(${bounds.west}, ${bounds.south}, ${bounds.east}, ${bounds.north}, 4326)::geography
            )
          LIMIT ${MAX_POINTS}`
      : await this.prisma.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "Facility"
          WHERE "isActive" AND "isVerified"
            AND "kind" != 'RESTRICTED'
            AND ST_DWithin(
              "geog",
              ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography,
              ${radiusMeters}
            )
          ORDER BY "geog" <-> ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography
          LIMIT ${MAX_POINTS}`
    return rows.map((r) => r.id)
  }

  /**
   * Cheap count of facilities in the search area using the same spatial predicate as
   * the points prefilter, so clustering can be decided without hydrating any rows.
   */
  private async countInArea(
    lat: number,
    lng: number,
    radiusMeters: number,
    bounds?: MapBounds,
  ): Promise<number> {
    const rows = bounds
      ? await this.prisma.$queryRaw<Array<{ count: number }>>`
          SELECT count(*)::int AS count FROM "Facility"
          WHERE "isActive" AND "isVerified"
            AND "kind" != 'RESTRICTED'
            AND ST_Intersects(
              "geog",
              ST_MakeEnvelope(${bounds.west}, ${bounds.south}, ${bounds.east}, ${bounds.north}, 4326)::geography
            )`
      : await this.prisma.$queryRaw<Array<{ count: number }>>`
          SELECT count(*)::int AS count FROM "Facility"
          WHERE "isActive" AND "isVerified"
            AND "kind" != 'RESTRICTED'
            AND ST_DWithin(
              "geog",
              ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography,
              ${radiusMeters}
            )`
    return rows[0]?.count ?? 0
  }

  /**
   * Aggregates in-bounds facilities into a fixed 12x12 grid of the visible rectangle.
   * The GiST index on `geog` serves the same ST_Intersects predicate as the points path.
   */
  private async buildClusters(bounds: MapBounds): Promise<FacilityCluster[]> {
    const COLS = 12
    const ROWS = 12
    const cellLng = (bounds.east - bounds.west) / COLS
    const cellLat = (bounds.north - bounds.south) / ROWS

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
        SELECT "geog"::geometry AS g FROM "Facility"
        WHERE "isActive" AND "isVerified"
          AND "kind" != 'RESTRICTED'
          AND ST_Intersects(
            "geog",
            ST_MakeEnvelope(${bounds.west}, ${bounds.south}, ${bounds.east}, ${bounds.north}, 4326)::geography
          )
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
    const { tariffAssignments, ...rest } = facility
    const assignments = tariffAssignments.map((a) => ({
      ...a,
      tariffPlan: a.tariffPlan.isActive ? a.tariffPlan : null,
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

    const operatorId = scope.kind === 'platform' ? dto.operatorId : scope.operatorId
    if (!operatorId) throw new DomainError('operatorId required')

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

    return this.runBulk(user, dto.action, dto.ids, scopeWhere, this.bulkData(dto.action))
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
    scopeWhere: { operatorId?: string },
  ): Promise<BulkFacilityResult> {
    const planIds = [
      ...new Set(
        assignments
          .map((a) => a.tariffPlanId)
          .filter((id): id is string => id !== null),
      ),
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
    scopeWhere: { operatorId?: string },
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

  private bulkData(
    action: Exclude<BulkFacilityAction, 'assignTariff'>,
  ): Prisma.FacilityUpdateManyMutationInput {
    switch (action) {
      case 'deploy':
        return { isActive: true, isVerified: true }
      case 'enable':
        return { isActive: true }
      case 'disable':
      case 'delete':
        return { isActive: false }
      case 'publish':
        return { isVerified: true }
      case 'unpublish':
        return { isVerified: false }
    }
  }

  async adminMap(user: AuthUser, params: AdminMapParams): Promise<AdminMapResponse> {
    const scope = await this.operatorScope.resolve(user)
    const where = this.adminMapWhere(scope, params)

    const total = await this.prisma.facility.count({ where })
    if (total === 0) return { mode: 'points', points: [], clusters: [], total }

    if (total > MAX_POINTS) {
      const clusters = await this.buildAdminClusters(where, params.bounds)
      return { mode: 'clusters', points: [], clusters, total }
    }

    const rows = await this.prisma.facility.findMany({
      where,
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

  private adminMapWhere(scope: OperatorScope, params: AdminMapParams): Prisma.FacilityWhereInput {
    const { bounds } = params
    const filters: Prisma.FacilityWhereInput[] = [
      { lat: { gte: bounds.south, lte: bounds.north } },
      { lng: { gte: bounds.west, lte: bounds.east } },
    ]
    if (params.q) {
      filters.push({
        OR: [
          { name: { contains: params.q, mode: 'insensitive' } },
          { address: { contains: params.q, mode: 'insensitive' } },
        ],
      })
    }
    if (params.isActive !== undefined) filters.push({ isActive: params.isActive })
    if (params.isVerified !== undefined) filters.push({ isVerified: params.isVerified })
    if (params.kind) filters.push({ kind: params.kind })
    if (scope.kind === 'platform' && params.operatorId) {
      filters.push({ operatorId: params.operatorId })
    }
    return { ...this.operatorScope.scopeWhere(scope), AND: filters }
  }

  /**
   * Aggregates in-bounds admin facilities into a 12x12 grid of the visible rectangle,
   * using the same scoped predicate as the points path so clustering respects filters.
   */
  private async buildAdminClusters(
    where: Prisma.FacilityWhereInput,
    bounds: MapBounds,
  ): Promise<FacilityCluster[]> {
    const COLS = 12
    const ROWS = 12
    const cellLng = (bounds.east - bounds.west) / COLS
    const cellLat = (bounds.north - bounds.south) / ROWS

    const rows = await this.prisma.facility.findMany({
      where,
      select: { lat: true, lng: true },
    })

    const cells = new Map<string, { count: number; latSum: number; lngSum: number }>()
    for (const row of rows) {
      const lat = row.lat.toNumber()
      const lng = row.lng.toNumber()
      const gx = Math.floor((lng - bounds.west) / cellLng)
      const gy = Math.floor((lat - bounds.south) / cellLat)
      const key = `${gx}_${gy}`
      const cell = cells.get(key) ?? { count: 0, latSum: 0, lngSum: 0 }
      cell.count += 1
      cell.latSum += lat
      cell.lngSum += lng
      cells.set(key, cell)
    }

    return Array.from(cells.entries()).map(([key, cell]) => ({
      id: `c_${key}`,
      lat: cell.latSum / cell.count,
      lng: cell.lngSum / cell.count,
      count: cell.count,
    }))
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
