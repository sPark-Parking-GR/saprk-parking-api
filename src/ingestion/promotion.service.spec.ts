import { FacilityKind, IngestSource, Prisma } from '@prisma/client'
import { UNCLAIMED_OPERATOR_ID } from './ingestion.constants'
import { PromotionService } from './promotion.service'
import type { PrismaService } from '../prisma/prisma.service'

const osmRaw = (tags: Record<string, string>) => ({ raw: { tags } })

describe('PromotionService.reclassifyUnknown', () => {
  let prisma: {
    facility: { findMany: jest.Mock; update: jest.Mock }
    rawPlace: { findUnique: jest.Mock }
  }
  let service: PromotionService

  beforeEach(() => {
    prisma = {
      facility: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([
            { id: 'a', sourceRef: 'node/1' }, // fee=yes  -> BUSINESS
            { id: 'b', sourceRef: 'node/2' }, // untagged -> stays UNKNOWN
            { id: 'c', sourceRef: 'node/3' }, // underground -> BUSINESS
          ])
          .mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
      },
      rawPlace: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce(osmRaw({ fee: 'yes' }))
          .mockResolvedValueOnce(osmRaw({ parking: 'surface' }))
          .mockResolvedValueOnce(osmRaw({ parking: 'underground' })),
      },
    }
    service = new PromotionService(prisma as unknown as PrismaService)
  })

  it('reclassifies rows with decisive tags and leaves untagged ones UNKNOWN', async () => {
    const stats = await service.reclassifyUnknown()

    expect(stats).toEqual({ scanned: 3, reclassified: 2 })
    expect(prisma.facility.update).toHaveBeenCalledTimes(2)
    expect(prisma.facility.update).toHaveBeenCalledWith({
      where: { id: 'a' },
      data: { kind: FacilityKind.BUSINESS },
    })
    expect(prisma.facility.update).toHaveBeenCalledWith({
      where: { id: 'c' },
      data: { kind: FacilityKind.BUSINESS },
    })
  })

  it('only scans UNKNOWN OSM facilities that carry a sourceRef', async () => {
    await service.reclassifyUnknown()

    expect(prisma.facility.findMany.mock.calls[0][0].where).toEqual({
      kind: FacilityKind.UNKNOWN,
      source: IngestSource.OSM,
      sourceRef: { not: null },
    })
  })
})

describe('PromotionService.drainPending', () => {
  const createdAt = new Date('2026-07-14T09:00:00Z')

  let tx: {
    facility: { create: jest.Mock }
    facilityOwnershipPeriod: { create: jest.Mock }
    facilityRule: { createMany: jest.Mock }
    rawPlace: { update: jest.Mock }
  }
  let prisma: Record<string, unknown>
  let service: PromotionService

  beforeEach(() => {
    tx = {
      facility: { create: jest.fn().mockResolvedValue({ id: 'f-new', createdAt }) },
      facilityOwnershipPeriod: { create: jest.fn().mockResolvedValue({}) },
      facilityRule: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
      rawPlace: { update: jest.fn().mockResolvedValue({}) },
    }
    prisma = {
      parkingOperator: { upsert: jest.fn().mockResolvedValue({}) },
      rawPlace: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([
            {
              id: 'raw1',
              source: IngestSource.OSM,
              sourceRef: 'node/1',
              lat: new Prisma.Decimal(37.98),
              lng: new Prisma.Decimal(23.72),
              raw: { tags: { name: 'Import Lot', capacity: '40' } },
              contentHash: 'hash1',
            },
          ])
          .mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
      },
      facility: { findUnique: jest.fn().mockResolvedValue(null) },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    }
    service = new PromotionService(prisma as unknown as PrismaService)
  })

  it('opens an ownership period with the new facility, or analytics cannot see it', async () => {
    const stats = await service.drainPending()

    expect(stats.created).toBe(1)
    expect(tx.facilityOwnershipPeriod.create).toHaveBeenCalledWith({
      data: {
        facilityId: 'f-new',
        operatorId: UNCLAIMED_OPERATOR_ID,
        from: createdAt,
        to: null,
      },
    })
  })
})
