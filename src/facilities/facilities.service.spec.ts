import type { VehicleType } from '@prisma/client'
import { FacilitiesService } from './facilities.service'
import type { InventoryService } from '../inventory/inventory.service'
import type { PrismaService } from '../prisma/prisma.service'
import type { TariffService } from '../tariff/tariff.service'
import type { OperatorScopeService } from '../common/authz/operator-scope.service'

const decimal = (n: number) => ({ toNumber: () => n }) as never

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
  let service: FacilitiesService

  beforeEach(() => {
    prisma = { facility: { findMany: jest.fn() }, $queryRaw: jest.fn().mockResolvedValue([]) }
    inventory = { countOverlappingByFacility: jest.fn().mockResolvedValue(new Map()) }
    tariff = { computeTotalsByFacility: jest.fn().mockResolvedValue(new Map()) }
    service = new FacilitiesService(
      prisma as unknown as PrismaService,
      inventory as unknown as InventoryService,
      tariff as unknown as TariffService,
      {} as unknown as OperatorScopeService,
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
    expect(inventory.countOverlappingByFacility).toHaveBeenCalledWith(['f1', 'f2'], startsAt, endsAt)

    const f1 = res.find((r) => r.id === 'f1')!
    expect(f1.remainingSlots).toBe(4)
    expect(f1.available).toBe(true)
    expect(f1.priceCents).toBe(500)
    expect(f1.thumbnailUrl).toBe('thumb.jpg')

    const f2 = res.find((r) => r.id === 'f2')!
    expect(f2.remainingSlots).toBe(0)
    expect(f2.available).toBe(false)
    expect(f2.priceCents).toBeNull()
  })

  it('orders by rank desc ahead of distance', async () => {
    prisma.$queryRaw.mockResolvedValue([{ id: 'f1' }, { id: 'f2' }])
    prisma.facility.findMany.mockResolvedValue([
      makeFacility({ id: 'f1', rank: 0, lat: decimal(37.98), lng: decimal(23.73) }),
      makeFacility({ id: 'f2', rank: 5, lat: decimal(37.99), lng: decimal(23.74) }),
    ])

    const res = await service.search({ lat: 37.98, lng: 23.73, radiusMeters: 5000, startsAt, endsAt })

    expect(res.map((r) => r.id)).toEqual(['f2', 'f1'])
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

    const res = await service.search({ lat: 37.98, lng: 23.73, radiusMeters: 5000, startsAt, endsAt })

    expect(tariff.computeTotalsByFacility).not.toHaveBeenCalled()
    expect(res[0]!.priceCents).toBeNull()
  })

  it('returns empty without hydrating or batching when the prefilter matches nothing', async () => {
    prisma.$queryRaw.mockResolvedValue([])

    const res = await service.search({ lat: 37.98, lng: 23.73, radiusMeters: 1000, startsAt, endsAt })

    expect(res).toEqual([])
    expect(prisma.facility.findMany).not.toHaveBeenCalled()
    expect(inventory.countOverlappingByFacility).not.toHaveBeenCalled()
  })
})
