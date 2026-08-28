import { Prisma, type VehicleType } from '@prisma/client'
import { FacilitiesService } from './facilities.service'
import type { FacilityClusterIndexService } from './facility-cluster-index.service'
import type { BookingService } from '../booking/booking.service'
import type { InventoryService } from '../inventory/inventory.service'
import type { LifecycleService } from '../lifecycle/lifecycle.service'
import type { PrismaService } from '../prisma/prisma.service'
import type { EntitlementService } from '../subscriptions/entitlement.service'
import type { TariffService } from '../tariff/tariff.service'
import type { OperatorScopeService } from '../common/authz/operator-scope.service'

import type { QuotaThresholdService } from '../subscriptions/quota-threshold.service'

const quotaThresholdStub = (): { checkOperatorQuotaThresholds: jest.Mock } => ({
  checkOperatorQuotaThresholds: jest.fn().mockResolvedValue(undefined),
})

const decimal = (n: number) => ({ toNumber: () => n }) as never

// Rebuilds the Sql the tagged template would have produced, so a test can inspect the
// placeholder text and the bound values separately.
const sqlOf = (call: unknown[]): Prisma.Sql =>
  Prisma.sql(call[0] as readonly string[], ...call.slice(1))

const startsAt = new Date('2026-06-18T10:00:00Z')
const endsAt = new Date('2026-06-18T12:00:00Z')

function makeFacility(over: Record<string, unknown> = {}) {
  return {
    id: 'f1',
    name: 'A',
    address: 'addr',
    lat: decimal(37.98),
    lng: decimal(23.73),
    onlineQuota: 5,
    rank: 0,
    images: [{ url: 'thumb.jpg' }],
    promotionPlan: null,
    ...over,
  }
}

describe('FacilitiesService.search', () => {
  let prisma: { facility: { findMany: jest.Mock }; $queryRaw: jest.Mock }
  let inventory: { countOverlappingByFacility: jest.Mock }
  let tariff: { computeTotalsByFacility: jest.Mock }
  let clusterIndex: { getClusters: jest.Mock }
  let service: FacilitiesService

  beforeEach(() => {
    prisma = { facility: { findMany: jest.fn() }, $queryRaw: jest.fn().mockResolvedValue([]) }
    inventory = { countOverlappingByFacility: jest.fn().mockResolvedValue(new Map()) }
    tariff = { computeTotalsByFacility: jest.fn().mockResolvedValue(new Map()) }
    clusterIndex = { getClusters: jest.fn().mockResolvedValue([]) }
    service = new FacilitiesService(
      prisma as unknown as PrismaService,
      inventory as unknown as InventoryService,
      tariff as unknown as TariffService,
      {} as unknown as OperatorScopeService,
      {} as unknown as BookingService,
      {} as unknown as EntitlementService,
      {} as unknown as LifecycleService,
      clusterIndex as unknown as FacilityClusterIndexService,
      quotaThresholdStub() as unknown as QuotaThresholdService,
    )
  })

  it('batches availability and price into one call each (no per-facility N+1)', async () => {
    prisma.$queryRaw.mockResolvedValue([{ id: 'f1' }, { id: 'f2' }])
    prisma.facility.findMany.mockResolvedValue([
      makeFacility({ id: 'f1', onlineQuota: 5 }),
      makeFacility({ id: 'f2', onlineQuota: 2, lat: decimal(37.981), lng: decimal(23.731) }),
    ])
    inventory.countOverlappingByFacility.mockResolvedValue(
      new Map([
        ['f1', 1],
        ['f2', 2],
      ]),
    )
    tariff.computeTotalsByFacility.mockResolvedValue(new Map([['f1', 500]]))

    const res = await service.search({
      lat: 37.98,
      lng: 23.73,
      radiusMeters: 5000,
      startsAt,
      endsAt,
      vehicleType: 'CAR' as VehicleType,
    })

    expect(inventory.countOverlappingByFacility).toHaveBeenCalledTimes(1)
    expect(tariff.computeTotalsByFacility).toHaveBeenCalledTimes(1)
    expect(inventory.countOverlappingByFacility).toHaveBeenCalledWith(
      ['f1', 'f2'],
      startsAt,
      endsAt,
    )

    expect(res.mode).toBe('points')

    const f1 = res.points.find((r) => r.id === 'f1')!
    expect(f1.remainingSlots).toBe(4)
    expect(f1.available).toBe(true)
    expect(f1.onlineBookingStatus).toBe('OPEN')
    expect(f1.priceCents).toBe(500)
    expect(f1.thumbnailUrl).toBe('thumb.jpg')

    const f2 = res.points.find((r) => r.id === 'f2')!
    expect(f2.remainingSlots).toBe(0)
    expect(f2.available).toBe(false)
    expect(f2.onlineBookingStatus).toBe('FULL')
    expect(f2.priceCents).toBeNull()
  })

  it('reports a zero-quota facility as NOT_OFFERED, not FULL', async () => {
    prisma.$queryRaw.mockResolvedValue([{ id: 'f2' }, { id: 'f3' }])
    prisma.facility.findMany.mockResolvedValue([
      makeFacility({ id: 'f2', onlineQuota: 2 }),
      makeFacility({ id: 'f3', onlineQuota: 0, lat: decimal(37.981), lng: decimal(23.731) }),
    ])
    inventory.countOverlappingByFacility.mockResolvedValue(new Map([['f2', 2]]))

    const res = await service.search({
      lat: 37.98,
      lng: 23.73,
      radiusMeters: 5000,
      startsAt,
      endsAt,
    })

    const f3 = res.points.find((r) => r.id === 'f3')!
    expect(f3.onlineBookingStatus).toBe('NOT_OFFERED')
    expect(f3.available).toBe(false)
    expect(f3.remainingSlots).toBe(0)

    const f2 = res.points.find((r) => r.id === 'f2')!
    expect(f2.onlineBookingStatus).toBe('FULL')
    expect(f2.available).toBe(false)
  })

  it('orders by rank desc ahead of distance', async () => {
    prisma.$queryRaw.mockResolvedValue([{ id: 'f1' }, { id: 'f2' }])
    prisma.facility.findMany.mockResolvedValue([
      makeFacility({ id: 'f1', rank: 0, lat: decimal(37.98), lng: decimal(23.73) }),
      makeFacility({ id: 'f2', rank: 5, lat: decimal(37.99), lng: decimal(23.74) }),
    ])

    const res = await service.search({
      lat: 37.98,
      lng: 23.73,
      radiusMeters: 5000,
      startsAt,
      endsAt,
    })

    expect(res.points.map((r) => r.id)).toEqual(['f2', 'f1'])
  })

  it('hydrates only the ids returned by the spatial prefilter', async () => {
    prisma.$queryRaw.mockResolvedValue([{ id: 'f1' }, { id: 'f2' }])
    prisma.facility.findMany.mockResolvedValue([makeFacility({ id: 'f1' })])

    await service.search({ lat: 37.98, lng: 23.73, radiusMeters: 5000, startsAt, endsAt })

    const where = prisma.facility.findMany.mock.calls[0]![0].where
    expect(where.id).toEqual({ in: ['f1', 'f2'] })
  })

  it('skips the price query and returns null prices when no vehicleType is given', async () => {
    prisma.$queryRaw.mockResolvedValue([{ id: 'f1' }])
    prisma.facility.findMany.mockResolvedValue([makeFacility({})])

    const res = await service.search({
      lat: 37.98,
      lng: 23.73,
      radiusMeters: 5000,
      startsAt,
      endsAt,
    })

    expect(tariff.computeTotalsByFacility).not.toHaveBeenCalled()
    expect(res.points[0]!.priceCents).toBeNull()
  })

  it('returns empty without hydrating or batching when the prefilter matches nothing', async () => {
    prisma.$queryRaw.mockResolvedValue([])

    const res = await service.search({
      lat: 37.98,
      lng: 23.73,
      radiusMeters: 1000,
      startsAt,
      endsAt,
    })

    expect(res.mode).toBe('points')
    expect(res.points).toEqual([])
    expect(prisma.facility.findMany).not.toHaveBeenCalled()
    expect(inventory.countOverlappingByFacility).not.toHaveBeenCalled()
  })

  it('returns index clusters (not points) when bounds match more than SEARCH_RENDER_BUDGET facilities', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([{ count: 1000 }])
    clusterIndex.getClusters.mockResolvedValueOnce([
      { id: 'c_0', lat: 37.98, lng: 23.73, count: 600 },
    ])
    const bounds = { north: 38, south: 37, east: 24, west: 23 }

    const res = await service.search({
      lat: 37.98,
      lng: 23.73,
      radiusMeters: 5000,
      bounds,
      startsAt,
      endsAt,
    })

    expect(res.mode).toBe('clusters')
    expect(res.total).toBe(1000)
    expect(res.points).toEqual([])
    expect(res.clusters).toEqual([{ id: 'c_0', lat: 37.98, lng: 23.73, count: 600 }])
    expect(prisma.facility.findMany).not.toHaveBeenCalled()

    const [cacheKey, whereSql, calledBounds] = clusterIndex.getClusters.mock.calls[0]!
    expect(cacheKey).toBe('all')
    expect(whereSql.text).toContain('isActive')
    expect(calledBounds).toEqual(bounds)
  })

  describe('vehicleType filtering', () => {
    const bounds = { north: 38, south: 37, east: 24, west: 23 }

    it('applies the vehicleType filter to the count, not only to the points', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([{ count: 3 }])
        .mockResolvedValueOnce([{ id: 'f1' }, { id: 'f2' }, { id: 'f3' }])
      prisma.facility.findMany.mockResolvedValue([makeFacility()])

      const res = await service.search({
        lat: 37.98,
        lng: 23.73,
        radiusMeters: 5000,
        bounds,
        startsAt,
        endsAt,
        vehicleType: 'CAR' as VehicleType,
      })

      const countSql = sqlOf(prisma.$queryRaw.mock.calls[0]!)
      const pointsSql = sqlOf(prisma.$queryRaw.mock.calls[1]!)

      expect(countSql.text).toContain('::"VehicleType" = ANY("vehicleTypes")')
      expect(countSql.values).toContain('CAR')
      expect(pointsSql.text).toContain('::"VehicleType" = ANY("vehicleTypes")')
      expect(pointsSql.values).toContain('CAR')
      expect(countSql.text).not.toContain('CAR')
      expect(res.total).toBe(3)
    })

    it('leaves the vehicle filter out of the Prisma hydration (SQL is the only source)', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([{ count: 1 }]).mockResolvedValueOnce([{ id: 'f1' }])
      prisma.facility.findMany.mockResolvedValue([makeFacility()])

      await service.search({
        lat: 37.98,
        lng: 23.73,
        radiusMeters: 5000,
        startsAt,
        endsAt,
        vehicleType: 'CAR' as VehicleType,
      })

      expect(prisma.facility.findMany.mock.calls[0]![0].where).toEqual({ id: { in: ['f1'] } })
    })

    it('omits the vehicle predicate entirely when no vehicleType is given', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([{ count: 0 }]).mockResolvedValueOnce([])

      await service.search({ lat: 37.98, lng: 23.73, radiusMeters: 5000, startsAt, endsAt })

      expect(sqlOf(prisma.$queryRaw.mock.calls[0]!).text).not.toContain('vehicleTypes')
    })

    it('stays in points mode when the vehicleType-filtered count fits SEARCH_RENDER_BUDGET', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([{ count: 60 }]).mockResolvedValueOnce([{ id: 'f1' }])
      prisma.facility.findMany.mockResolvedValue([makeFacility()])

      const res = await service.search({
        lat: 37.98,
        lng: 23.73,
        radiusMeters: 5000,
        bounds,
        startsAt,
        endsAt,
        vehicleType: 'CAR' as VehicleType,
      })

      expect(res.mode).toBe('points')
      expect(res.total).toBe(60)
      expect(res.points).toHaveLength(1)
      expect(clusterIndex.getClusters).not.toHaveBeenCalled()
    })

    it('flips to clusters on the filtered count and clusters the same filtered set', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([{ count: 61 }])
      clusterIndex.getClusters.mockResolvedValueOnce([
        { id: 'c_1', lat: 37.5, lng: 23.5, count: 61 },
      ])

      const res = await service.search({
        lat: 37.98,
        lng: 23.73,
        radiusMeters: 5000,
        bounds,
        startsAt,
        endsAt,
        vehicleType: 'CAR' as VehicleType,
      })

      expect(res.mode).toBe('clusters')
      expect(res.clusters).toEqual([{ id: 'c_1', lat: 37.5, lng: 23.5, count: 61 }])

      const [cacheKey, whereSql] = clusterIndex.getClusters.mock.calls[0]!
      expect(cacheKey).toBe('CAR')
      expect(whereSql.text).toContain('::"VehicleType" = ANY("vehicleTypes")')
      expect(whereSql.values).toContain('CAR')
      expect(prisma.facility.findMany).not.toHaveBeenCalled()
    })
  })
})

describe('FacilitiesService.getDetail', () => {
  let prisma: {
    facility: { findFirst: jest.Mock }
    review: { aggregate: jest.Mock }
  }
  let service: FacilitiesService

  const activePlan = {
    id: 'plan1',
    isActive: true,
    lifecycleStatus: 'ACTIVE',
    name: 'Standard',
    tiers: [],
    windows: [],
    caps: [],
  }
  const inactivePlan = { ...activePlan, id: 'plan2', isActive: false }
  const archivedPlan = { ...activePlan, id: 'plan3', lifecycleStatus: 'ARCHIVED' }

  function detailRow(tariffAssignments: { vehicleType: string; tariffPlan: unknown }[]) {
    return {
      id: 'f1',
      name: 'Lot A',
      lat: decimal(37.98),
      lng: decimal(23.73),
      images: [],
      rules: [],
      tariffAssignments,
    }
  }

  beforeEach(() => {
    prisma = {
      facility: { findFirst: jest.fn() },
      review: { aggregate: jest.fn().mockResolvedValue({ _avg: { rating: null }, _count: 0 }) },
    }
    service = new FacilitiesService(
      prisma as unknown as PrismaService,
      {} as unknown as InventoryService,
      {} as unknown as TariffService,
      {} as unknown as OperatorScopeService,
      {} as unknown as BookingService,
      {} as unknown as EntitlementService,
      {} as unknown as LifecycleService,
      {} as unknown as FacilityClusterIndexService,
      quotaThresholdStub() as unknown as QuotaThresholdService,
    )
  })

  it('includes the tariffAssignments relation (an array, not a singular plan)', async () => {
    prisma.facility.findFirst.mockResolvedValue(
      detailRow([{ vehicleType: 'CAR', tariffPlan: activePlan }]),
    )

    const res = await service.getDetail('f1')

    const include = prisma.facility.findFirst.mock.calls[0]![0].include as Record<string, unknown>
    expect(include.tariffAssignments).toBeDefined()
    expect(include.tariffPlan).toBeUndefined()
    expect(res.tariffAssignments).toEqual([{ vehicleType: 'CAR', tariffPlan: activePlan }])
  })

  it('nulls out an assigned-but-inactive plan per row (no dead live pricing)', async () => {
    prisma.facility.findFirst.mockResolvedValue(
      detailRow([
        { vehicleType: 'CAR', tariffPlan: activePlan },
        { vehicleType: 'TRUCK', tariffPlan: inactivePlan },
      ]),
    )

    const res = await service.getDetail('f1')

    expect(res.tariffAssignments).toEqual([
      { vehicleType: 'CAR', tariffPlan: activePlan },
      { vehicleType: 'TRUCK', tariffPlan: null },
    ])
  })

  it('nulls out an assigned plan that is no longer lifecycle-active (nested includes bypass the default filter)', async () => {
    prisma.facility.findFirst.mockResolvedValue(
      detailRow([{ vehicleType: 'CAR', tariffPlan: archivedPlan }]),
    )

    const res = await service.getDetail('f1')

    expect(res.tariffAssignments).toEqual([{ vehicleType: 'CAR', tariffPlan: null }])
  })

  it('returns an empty tariffAssignments array when nothing is assigned', async () => {
    prisma.facility.findFirst.mockResolvedValue(detailRow([]))

    const res = await service.getDetail('f1')

    expect(res.tariffAssignments).toEqual([])
  })
})
