import { BookingStatus } from '@prisma/client'
import { InventoryService } from './inventory.service'
import type { PrismaService } from '../prisma/prisma.service'

const startsAt = new Date('2026-06-18T10:00:00Z')
const endsAt = new Date('2026-06-18T12:00:00Z')

describe('InventoryService.countOverlappingByFacility', () => {
  let prisma: { booking: { groupBy: jest.Mock } }
  let service: InventoryService

  beforeEach(() => {
    prisma = { booking: { groupBy: jest.fn() } }
    service = new InventoryService(prisma as unknown as PrismaService)
  })

  it('returns a count map keyed by facility, omitting facilities with no overlap', async () => {
    prisma.booking.groupBy.mockResolvedValue([
      { facilityId: 'f1', _count: { _all: 3 } },
      { facilityId: 'f2', _count: { _all: 1 } },
    ])

    const map = await service.countOverlappingByFacility(['f1', 'f2', 'f3'], startsAt, endsAt)

    expect(map.get('f1')).toBe(3)
    expect(map.get('f2')).toBe(1)
    expect(map.has('f3')).toBe(false)

    const arg = prisma.booking.groupBy.mock.calls[0]![0]
    expect(arg.by).toEqual(['facilityId'])
    expect(arg.where.facilityId).toEqual({ in: ['f1', 'f2', 'f3'] })
    expect(arg.where.status.in).toContain(BookingStatus.CONFIRMED)
  })

  it('skips the query and returns an empty map for no ids', async () => {
    const map = await service.countOverlappingByFacility([], startsAt, endsAt)

    expect(map.size).toBe(0)
    expect(prisma.booking.groupBy).not.toHaveBeenCalled()
  })
})
