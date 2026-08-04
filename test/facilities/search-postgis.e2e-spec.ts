import { FacilityKind, Prisma, VehicleType } from '@prisma/client'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { FacilitiesService } from '../../src/facilities/facilities.service'
import type { MapBounds } from '../../src/facilities/facilities.types'
import type { PrismaService } from '../../src/prisma/prisma.service'
import { truncateAll } from '../utils/db'
import { seedFacility, seedUnclaimedOperator, UNCLAIMED_OPERATOR_ID } from '../utils/seed'
import { createTestApp } from '../utils/test-app'

const CENTRE = { lat: 37.9838, lng: 23.7275 }
const STARTS_AT = new Date('2026-09-01T10:00:00.000Z')
const ENDS_AT = new Date('2026-09-01T12:00:00.000Z')

// Public search switches to the supercluster index above SEARCH_RENDER_BUDGET (60) matches
// in bounds (see FacilitiesService.search / SEARCH_RENDER_BUDGET). adminMap is unaffected
// and still gates on the separate MAX_POINTS (250) grid, but this file never exercises it.
const SEARCH_RENDER_BUDGET = 60

const TIGHT_BOUNDS: MapBounds = {
  north: CENTRE.lat + 0.01,
  south: CENTRE.lat - 0.01,
  east: CENTRE.lng + 0.01,
  west: CENTRE.lng - 0.01,
}

function searchParams(overrides: Partial<Parameters<FacilitiesService['search']>[0]> = {}) {
  return {
    lat: CENTRE.lat,
    lng: CENTRE.lng,
    radiusMeters: 1_000,
    startsAt: STARTS_AT,
    endsAt: ENDS_AT,
    ...overrides,
  }
}

describe('facility search PostGIS (e2e)', () => {
  let app: NestFastifyApplication
  let prisma: PrismaService
  let facilities: FacilitiesService

  beforeAll(async () => {
    const testApp = await createTestApp()
    app = testApp.app
    prisma = testApp.prisma
    facilities = app.get(FacilitiesService)
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(async () => {
    await truncateAll(prisma)
    await seedUnclaimedOperator(prisma)
  })

  it('returns only facilities inside the radius, nearest first', async () => {
    const [atCentre, nearby] = await Promise.all([
      seedFacility(prisma, {
        operatorId: UNCLAIMED_OPERATOR_ID,
        name: 'At centre',
        ...CENTRE,
      }),
      seedFacility(prisma, {
        operatorId: UNCLAIMED_OPERATOR_ID,
        name: 'Nearby',
        lat: CENTRE.lat + 0.004,
        lng: CENTRE.lng,
      }),
      seedFacility(prisma, {
        operatorId: UNCLAIMED_OPERATOR_ID,
        name: 'Far away',
        lat: CENTRE.lat + 0.02,
        lng: CENTRE.lng,
      }),
    ])

    const result = await facilities.search(searchParams())

    expect(result.mode).toBe('points')
    expect(result.total).toBe(2)
    expect(result.points.map((p) => p.id)).toEqual([atCentre.id, nearby.id])
    expect(result.points[0]?.distanceMeters).toBe(0)
    expect(result.points[1]?.distanceMeters).toBeGreaterThan(400)
    expect(result.points[1]?.distanceMeters).toBeLessThan(500)
  })

  it('widening the radius admits a facility that was outside it', async () => {
    await seedFacility(prisma, {
      operatorId: UNCLAIMED_OPERATOR_ID,
      lat: CENTRE.lat + 0.02,
      lng: CENTRE.lng,
    })

    await expect(facilities.search(searchParams())).resolves.toMatchObject({ total: 0 })
    await expect(facilities.search(searchParams({ radiusMeters: 5_000 }))).resolves.toMatchObject({
      total: 1,
    })
  })

  it('excludes restricted, inactive and unverified facilities from public search', async () => {
    const visible = await seedFacility(prisma, {
      operatorId: UNCLAIMED_OPERATOR_ID,
      name: 'Visible',
      ...CENTRE,
    })

    await Promise.all([
      seedFacility(prisma, {
        operatorId: UNCLAIMED_OPERATOR_ID,
        name: 'Restricted',
        ...CENTRE,
        kind: FacilityKind.RESTRICTED,
      }),
      seedFacility(prisma, {
        operatorId: UNCLAIMED_OPERATOR_ID,
        name: 'Inactive',
        ...CENTRE,
        isActive: false,
      }),
      seedFacility(prisma, {
        operatorId: UNCLAIMED_OPERATOR_ID,
        name: 'Unverified',
        ...CENTRE,
        isVerified: false,
      }),
    ])

    const [radius, bounded] = await Promise.all([
      facilities.search(searchParams()),
      facilities.search(searchParams({ bounds: TIGHT_BOUNDS })),
    ])

    expect(radius.total).toBe(1)
    expect(radius.points.map((p) => p.id)).toEqual([visible.id])
    // The count, the point prefilter and the cluster buckets share one visibility
    // predicate; the bounds path must agree with the radius path about what is listable.
    expect(bounded.total).toBe(1)
    expect(bounded.points.map((p) => p.id)).toEqual([visible.id])
  })

  it('applies the vehicle-type filter to both the points and the total', async () => {
    const [truckPark] = await Promise.all([
      seedFacility(prisma, {
        operatorId: UNCLAIMED_OPERATOR_ID,
        name: 'Truck park',
        ...CENTRE,
        vehicleTypes: [VehicleType.TRUCK, VehicleType.VAN],
      }),
      seedFacility(prisma, {
        operatorId: UNCLAIMED_OPERATOR_ID,
        name: 'Cars only',
        ...CENTRE,
        vehicleTypes: [VehicleType.CAR],
      }),
    ])

    const result = await facilities.search(searchParams({ vehicleType: VehicleType.TRUCK }))

    expect(result.total).toBe(1)
    expect(result.points.map((p) => p.id)).toEqual([truckPark.id])
  })

  it('restricts the bounds path to the rectangle, not the radius circle', async () => {
    const [inside] = await Promise.all([
      seedFacility(prisma, { operatorId: UNCLAIMED_OPERATOR_ID, name: 'Inside', ...CENTRE }),
      seedFacility(prisma, {
        operatorId: UNCLAIMED_OPERATOR_ID,
        name: 'Outside the box',
        lat: CENTRE.lat + 0.05,
        lng: CENTRE.lng,
      }),
    ])

    // A radius wide enough to include both, so only the rectangle can exclude the second.
    const result = await facilities.search(
      searchParams({ bounds: TIGHT_BOUNDS, radiusMeters: 50_000 }),
    )

    expect(result.mode).toBe('points')
    expect(result.points.map((p) => p.id)).toEqual([inside.id])
    expect(result.total).toBe(1)
  })

  describe('cluster mode (supercluster index)', () => {
    const CLUSTERED = SEARCH_RENDER_BUDGET + 11

    beforeEach(async () => {
      const cellLat = (TIGHT_BOUNDS.north - TIGHT_BOUNDS.south) / 12
      const cellLng = (TIGHT_BOUNDS.east - TIGHT_BOUNDS.west) / 12

      await prisma.facility.createMany({
        data: Array.from({ length: CLUSTERED }, (_, index) => {
          // Walk a 12x12 grid so the fixture spans many cells instead of one repeated
          // point; the supercluster index this feeds re-merges them on its own terms, not
          // by this layout, so no assertion below depends on the exact spacing.
          const column = index % 12
          const row = Math.floor(index / 12) % 12
          return {
            operatorId: UNCLAIMED_OPERATOR_ID,
            name: `Clustered ${index}`,
            address: '1 Test Street',
            lat: new Prisma.Decimal(TIGHT_BOUNDS.south + (row + 0.5) * cellLat),
            lng: new Prisma.Decimal(TIGHT_BOUNDS.west + (column + 0.5) * cellLng),
            totalCapacity: 100,
            onlineQuota: 10,
            vehicleTypes: [VehicleType.CAR],
            openingHoursJson: { is24h: true },
            amenities: [],
            isActive: true,
            isVerified: true,
            kind: FacilityKind.BUSINESS,
          }
        }),
      })
    })

    it('switches to clusters above the render budget and preserves the total', async () => {
      const result = await facilities.search(searchParams({ bounds: TIGHT_BOUNDS }))

      expect(result.mode).toBe('clusters')
      expect(result.points).toEqual([])
      expect(result.total).toBe(CLUSTERED)

      const clustered = result.clusters.reduce((sum, cluster) => sum + cluster.count, 0)
      expect(clustered).toBe(CLUSTERED)
    })

    it('merges nearby facilities into fewer clusters, each centred inside the requested rectangle', async () => {
      const { clusters } = await facilities.search(searchParams({ bounds: TIGHT_BOUNDS }))

      expect(clusters.length).toBeGreaterThan(0)
      expect(clusters.length).toBeLessThan(CLUSTERED)
      expect(new Set(clusters.map((c) => c.id)).size).toBe(clusters.length)

      for (const cluster of clusters) {
        expect(cluster.lat).toBeGreaterThanOrEqual(TIGHT_BOUNDS.south)
        expect(cluster.lat).toBeLessThanOrEqual(TIGHT_BOUNDS.north)
        expect(cluster.lng).toBeGreaterThanOrEqual(TIGHT_BOUNDS.west)
        expect(cluster.lng).toBeLessThanOrEqual(TIGHT_BOUNDS.east)
      }
    })

    it('counts the same set the points path would list, under one visibility predicate', async () => {
      const hidden = await Promise.all([
        seedFacility(prisma, {
          operatorId: UNCLAIMED_OPERATOR_ID,
          ...CENTRE,
          kind: FacilityKind.RESTRICTED,
        }),
        seedFacility(prisma, { operatorId: UNCLAIMED_OPERATOR_ID, ...CENTRE, isActive: false }),
      ])

      const { clusters, total } = await facilities.search(searchParams({ bounds: TIGHT_BOUNDS }))
      const clustered = clusters.reduce((sum, cluster) => sum + cluster.count, 0)

      expect(hidden).toHaveLength(2)
      expect(total).toBe(CLUSTERED)
      expect(clustered).toBe(CLUSTERED)
    })
  })
})
