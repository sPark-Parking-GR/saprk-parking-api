import { TariffType, type VehicleType } from '@prisma/client'
import { TariffService } from './tariff.service'
import type { PrismaService } from '../prisma/prisma.service'

const startsAt = new Date('2026-06-18T10:00:00Z')
const endsAt = new Date('2026-06-18T12:00:00Z')

function flatRule(priceCents: number) {
  return {
    type: TariffType.FLAT,
    priceCents,
    vehicleTypes: [] as VehicleType[],
    minDurationMinutes: null,
    maxDurationMinutes: null,
    sortOrder: 0,
  }
}

describe('TariffService.computeTotalsByFacility', () => {
  let prisma: { tariffPlan: { findMany: jest.Mock } }
  let service: TariffService

  beforeEach(() => {
    prisma = { tariffPlan: { findMany: jest.fn() } }
    service = new TariffService(prisma as unknown as PrismaService)
  })

  it('totals one active plan per facility, taking the first seen in the query order', async () => {
    prisma.tariffPlan.findMany.mockResolvedValue([
      { facilityId: 'f1', rules: [flatRule(800)] },
      { facilityId: 'f1', rules: [flatRule(999)] },
      { facilityId: 'f2', rules: [flatRule(1500)] },
    ])

    const totals = await service.computeTotalsByFacility(
      ['f1', 'f2'],
      startsAt,
      endsAt,
      'CAR' as VehicleType,
    )

    expect(totals.get('f1')).toBe(800)
    expect(totals.get('f2')).toBe(1500)
  })

  it('omits facilities with no applicable plan', async () => {
    prisma.tariffPlan.findMany.mockResolvedValue([{ facilityId: 'f1', rules: [flatRule(800)] }])

    const totals = await service.computeTotalsByFacility(
      ['f1', 'f2'],
      startsAt,
      endsAt,
      'CAR' as VehicleType,
    )

    expect(totals.has('f2')).toBe(false)
  })

  it('skips the query for empty ids or a non-positive window', async () => {
    expect((await service.computeTotalsByFacility([], startsAt, endsAt, 'CAR' as VehicleType)).size).toBe(0)
    expect(
      (await service.computeTotalsByFacility(['f1'], endsAt, startsAt, 'CAR' as VehicleType)).size,
    ).toBe(0)
    expect(prisma.tariffPlan.findMany).not.toHaveBeenCalled()
  })
})
