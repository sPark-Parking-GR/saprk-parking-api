import { FacilityKind, Prisma } from '@prisma/client'
import type { AuthUser } from '@spark/types'
import { FacilityNotFoundError } from '../common/errors/domain.errors'
import type { PrismaService } from '../prisma/prisma.service'
import { SavedFacilitiesService } from './saved-facilities.service'

const user: AuthUser = {
  id: 'u-owner',
  email: 'owner@spark.gr',
  role: 'user',
  emailVerified: true,
}

function savedRow(overrides: Record<string, unknown> = {}) {
  return {
    createdAt: new Date('2026-07-01T08:00:00.000Z'),
    facility: {
      id: 'f1',
      name: 'Alpha garage',
      address: '1 Test Street',
      lat: new Prisma.Decimal(37.9838),
      lng: new Prisma.Decimal(23.7275),
      kind: FacilityKind.BUSINESS,
      isActive: true,
      isPublished: true,
      ...overrides,
    },
  }
}

describe('SavedFacilitiesService', () => {
  let prisma: {
    savedFacility: { findMany: jest.Mock; upsert: jest.Mock; deleteMany: jest.Mock }
    facility: { findFirst: jest.Mock }
  }
  let service: SavedFacilitiesService

  beforeEach(() => {
    prisma = {
      savedFacility: {
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn(),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      facility: { findFirst: jest.fn() },
    }
    service = new SavedFacilitiesService(prisma as unknown as PrismaService)
  })

  it('lists only the caller own bookmarks, newest first', async () => {
    await service.list(user)

    const args = prisma.savedFacility.findMany.mock.calls[0]![0]
    expect(args.where).toEqual({ userId: 'u-owner' })
    expect(args.orderBy).toEqual({ createdAt: 'desc' })
  })

  it('keeps an archived facility in the list, flagged unavailable instead of failing', async () => {
    prisma.savedFacility.findMany.mockResolvedValue([
      savedRow(),
      savedRow({ id: 'f2', isActive: false }),
      savedRow({ id: 'f3', isPublished: false }),
      savedRow({ id: 'f4', kind: FacilityKind.RESTRICTED }),
    ])

    const result = await service.list(user)

    expect(result.total).toBe(4)
    expect(result.items.map((item) => item.available)).toEqual([true, false, false, false])
    expect(result.items[0]!.lat).toBeCloseTo(37.9838, 6)
  })

  it('refuses to save a facility the caller could not have discovered', async () => {
    prisma.facility.findFirst.mockResolvedValue(null)

    await expect(service.add(user, 'f-hidden')).rejects.toBeInstanceOf(FacilityNotFoundError)
    expect(prisma.savedFacility.upsert).not.toHaveBeenCalled()
  })

  it('saves through an upsert, so a repeated save is not a conflict', async () => {
    prisma.facility.findFirst.mockResolvedValue({ id: 'f1' })
    prisma.savedFacility.upsert.mockResolvedValue(savedRow())

    const item = await service.add(user, 'f1')

    expect(prisma.savedFacility.upsert.mock.calls[0]![0].where).toEqual({
      userId_facilityId: { userId: 'u-owner', facilityId: 'f1' },
    })
    expect(prisma.savedFacility.upsert.mock.calls[0]![0].update).toEqual({})
    expect(item.facilityId).toBe('f1')
    expect(item.available).toBe(true)
  })

  it('unsaves within the caller own rows and stays a no-op when there is nothing to remove', async () => {
    await service.remove(user, 'f1')

    expect(prisma.savedFacility.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'u-owner', facilityId: 'f1' },
    })
  })
})
