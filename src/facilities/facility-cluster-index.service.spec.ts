import { Prisma } from '@prisma/client'
import { FacilityClusterIndexService, zoomFromBounds } from './facility-cluster-index.service'
import {
  getFacilityClusterIndexVersion,
  invalidateFacilityClusterIndex,
} from './facility-cluster-invalidation'
import type { MapBounds } from './facilities.types'
import type { PrismaService } from '../prisma/prisma.service'

const WHERE = Prisma.sql`"isActive"`

// Mirrors the service's own constants; the debounce window is the invalidation module's.
const MAX_INDEX_AGE_MS = 60_000
const MAX_INDEX_POINTS = 200_000
const DEBOUNCE_MS = 1_000

function row(id: string, lat: number, lng: number) {
  return { id, lat, lng }
}

describe('FacilityClusterIndexService', () => {
  let prisma: { $queryRaw: jest.Mock }
  let service: FacilityClusterIndexService

  beforeEach(() => {
    // Fake timers drive both clocks this suite depends on: the cache's Date.now() age stamp
    // and the debounce behind invalidateFacilityClusterIndex.
    jest.useFakeTimers()
    prisma = { $queryRaw: jest.fn().mockResolvedValue([]) }
    service = new FacilityClusterIndexService(prisma as unknown as PrismaService)
  })

  afterEach(() => {
    jest.runOnlyPendingTimers()
    jest.useRealTimers()
  })

  it('builds from the DB on first call and returns both a cluster and an unclustered leaf', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([
      row('f1', 0, 0),
      row('f2', 0.0001, 0.0001),
      row('lone', 0, 50),
    ])
    const bounds: MapBounds = { north: 5, south: -5, east: 60, west: -5 }

    const clusters = await service.getClusters('all', WHERE, bounds)

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1)
    expect(clusters).toHaveLength(2)

    const merged = clusters.find((c) => c.count === 2)!
    expect(merged.id).toMatch(/^c_\d+$/)
    expect(merged.lat).toBeCloseTo(0, 3)
    expect(merged.lng).toBeCloseTo(0, 3)

    const leaf = clusters.find((c) => c.count === 1)!
    expect(leaf).toEqual({ id: 'lone', lat: 0, lng: 50, count: 1 })
  })

  it('serves a second call for the same cacheKey from cache, without re-querying', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([row('f1', 0, 0)])
    const bounds: MapBounds = { north: 1, south: -1, east: 1, west: -1 }

    await service.getClusters('all', WHERE, bounds)
    await service.getClusters('all', WHERE, bounds)

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1)
  })

  it('rebuilds on the next call after invalidateFacilityClusterIndex bumps the version', async () => {
    prisma.$queryRaw.mockResolvedValue([row('f1', 0, 0)])
    const bounds: MapBounds = { north: 1, south: -1, east: 1, west: -1 }

    await service.getClusters('all', WHERE, bounds)
    const before = getFacilityClusterIndexVersion()
    invalidateFacilityClusterIndex()
    jest.advanceTimersByTime(DEBOUNCE_MS)
    await service.getClusters('all', WHERE, bounds)

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2)
    expect(getFacilityClusterIndexVersion()).toBe(before + 1)
  })

  it('keeps serving the cached index while it is younger than the max age', async () => {
    prisma.$queryRaw.mockResolvedValue([row('f1', 0, 0)])
    const bounds: MapBounds = { north: 1, south: -1, east: 1, west: -1 }

    await service.getClusters('all', WHERE, bounds)
    jest.advanceTimersByTime(MAX_INDEX_AGE_MS)
    await service.getClusters('all', WHERE, bounds)

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1)
  })

  // The floor under a version bump that landed before its transaction committed, and under a
  // write another replica served: neither changes THIS process's version, so only age does.
  it('rebuilds once the cached index is older than the max age, version unchanged', async () => {
    prisma.$queryRaw.mockResolvedValue([row('f1', 0, 0)])
    const bounds: MapBounds = { north: 1, south: -1, east: 1, west: -1 }

    await service.getClusters('all', WHERE, bounds)
    const version = getFacilityClusterIndexVersion()
    jest.advanceTimersByTime(MAX_INDEX_AGE_MS + 1)
    await service.getClusters('all', WHERE, bounds)

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2)
    expect(getFacilityClusterIndexVersion()).toBe(version)
  })

  it('restarts the age window from the rebuild', async () => {
    prisma.$queryRaw.mockResolvedValue([row('f1', 0, 0)])
    const bounds: MapBounds = { north: 1, south: -1, east: 1, west: -1 }

    await service.getClusters('all', WHERE, bounds)
    jest.advanceTimersByTime(MAX_INDEX_AGE_MS + 1)
    await service.getClusters('all', WHERE, bounds)
    jest.advanceTimersByTime(MAX_INDEX_AGE_MS)
    await service.getClusters('all', WHERE, bounds)

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2)
  })

  it('caps the build query at the backstop point limit', async () => {
    const bounds: MapBounds = { north: 1, south: -1, east: 1, west: -1 }

    await service.getClusters('all', WHERE, bounds)

    const [fragments, ...values] = prisma.$queryRaw.mock.calls[0]!
    expect((fragments as string[]).join('')).toContain('LIMIT')
    expect(values).toContain(MAX_INDEX_POINTS)
  })

  it('builds an independent index per cacheKey', async () => {
    prisma.$queryRaw.mockResolvedValue([row('f1', 0, 0)])
    const bounds: MapBounds = { north: 1, south: -1, east: 1, west: -1 }

    await service.getClusters('all', WHERE, bounds)
    await service.getClusters('CAR', WHERE, bounds)

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2)
  })

  it('coalesces concurrent misses on the same new cacheKey into one DB query', async () => {
    let resolveRows!: (rows: unknown[]) => void
    prisma.$queryRaw.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRows = resolve
      }),
    )
    const bounds: MapBounds = { north: 1, south: -1, east: 1, west: -1 }

    const first = service.getClusters('all', WHERE, bounds)
    const second = service.getClusters('all', WHERE, bounds)
    resolveRows([row('f1', 0, 0)])

    const [firstResult, secondResult] = await Promise.all([first, second])

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1)
    expect(firstResult).toEqual(secondResult)
  })
})

describe('zoomFromBounds', () => {
  it('returns zoom 0 for a world-width bounds', () => {
    expect(zoomFromBounds({ north: 0, south: 0, east: 180, west: -180 })).toBe(0)
  })

  it('returns roughly one zoom level more for half the world width', () => {
    expect(zoomFromBounds({ north: 0, south: 0, east: 90, west: -90 })).toBe(1)
  })

  it('clamps to the max zoom (16) for a very narrow bounds', () => {
    expect(zoomFromBounds({ north: 0, south: 0, east: 0.0001, west: -0.0001 })).toBe(16)
  })
})
