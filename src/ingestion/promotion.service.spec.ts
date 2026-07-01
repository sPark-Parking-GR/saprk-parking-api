import { FacilityKind, IngestSource } from '@prisma/client'
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
