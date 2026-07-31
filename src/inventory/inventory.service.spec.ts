import { BookingStatus, FacilityKind } from '@prisma/client'
import { InventoryService } from './inventory.service'
import { FacilityNotBookableError } from '../common/errors/domain.errors'
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

describe('InventoryService.holdSlot', () => {
  type Client = {
    $executeRaw: jest.Mock
    facility: { findUnique: jest.Mock }
    booking: { count: jest.Mock; create: jest.Mock }
  }

  function makeClient(): Client {
    return {
      $executeRaw: jest.fn(),
      facility: { findUnique: jest.fn() },
      booking: {
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue({ id: 'b1', expiresAt: new Date() }),
      },
    }
  }

  function makeService(client: Client): InventoryService {
    const prisma = { $transaction: jest.fn((run: (c: Client) => unknown) => run(client)) }
    return new InventoryService(prisma as unknown as PrismaService)
  }

  const holdParams = {
    facilityId: 'f1',
    startsAt,
    endsAt,
    quotedPriceCents: 500,
    vehiclePlate: 'ABC123',
    vehicleType: 'CAR',
    accessCode: 'CODE1234',
    tariffPlanId: 'plan1',
    tariffPlanVersion: 3,
    userId: 'u1',
    sourceChannel: 'MOBILE',
  }

  it('holds a BUSINESS, active, verified facility with available quota', async () => {
    const client = makeClient()
    client.facility.findUnique.mockResolvedValue({
      onlineQuota: 5,
      isActive: true,
      isVerified: true,
      kind: FacilityKind.BUSINESS,
    })
    const service = makeService(client)

    const result = await service.holdSlot(holdParams)

    expect(result.bookingId).toBe('b1')
    expect(client.booking.create).toHaveBeenCalledTimes(1)
  })

  it('persists the owning user and the caller-supplied channel, with no guest fields', async () => {
    const client = makeClient()
    client.facility.findUnique.mockResolvedValue({
      onlineQuota: 5,
      isActive: true,
      isVerified: true,
      kind: FacilityKind.BUSINESS,
    })
    const service = makeService(client)

    await service.holdSlot(holdParams)

    const data = client.booking.create.mock.calls[0]![0].data
    expect(data.userId).toBe('u1')
    expect(data.sourceChannel).toBe('MOBILE')
    expect(data).not.toHaveProperty('guestEmail')
    expect(data).not.toHaveProperty('guestPhone')
  })

  it('pins the plan revision that priced the quote onto the booking row', async () => {
    const client = makeClient()
    client.facility.findUnique.mockResolvedValue({
      onlineQuota: 5,
      isActive: true,
      isVerified: true,
      kind: FacilityKind.BUSINESS,
    })
    const service = makeService(client)

    await service.holdSlot(holdParams)

    const data = client.booking.create.mock.calls[0]![0].data
    expect(data.tariffPlanId).toBe('plan1')
    expect(data.tariffPlanVersion).toBe(3)
  })

  it('rejects an inactive facility with a domain error, not a raw Error', async () => {
    const client = makeClient()
    client.facility.findUnique.mockResolvedValue({
      onlineQuota: 5,
      isActive: false,
      isVerified: true,
      kind: FacilityKind.BUSINESS,
    })
    const service = makeService(client)

    await expect(service.holdSlot(holdParams)).rejects.toBeInstanceOf(FacilityNotBookableError)
    expect(client.booking.create).not.toHaveBeenCalled()
  })

  it('rejects a non-BUSINESS facility even when active and verified', async () => {
    const client = makeClient()
    client.facility.findUnique.mockResolvedValue({
      onlineQuota: 5,
      isActive: true,
      isVerified: true,
      kind: FacilityKind.FREE_PUBLIC,
    })
    const service = makeService(client)

    await expect(service.holdSlot(holdParams)).rejects.toBeInstanceOf(FacilityNotBookableError)
    expect(client.booking.create).not.toHaveBeenCalled()
  })
})
