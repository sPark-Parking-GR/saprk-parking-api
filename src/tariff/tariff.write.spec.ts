import type { AuthUser } from '@spark/types'
import { TariffService } from './tariff.service'
import { OperatorScopeService, type OperatorScope } from '../common/authz/operator-scope.service'
import {
  FacilityNotFoundError,
  InvalidTariffScheduleError,
} from '../common/errors/domain.errors'
import { validateRateGrid } from './schedule-validation'
import type { PrismaService } from '../prisma/prisma.service'
import { tariffDraftSchema, type TariffDraftDto } from './dto/tariff.dto'

const operatorUser: AuthUser = {
  id: 'u-op',
  email: 'op@spark.gr',
  role: 'operator_admin',
  emailVerified: true,
}

// Day 06:00-22:00 (360-1320), Night otherwise (wrap). Hourly blocks. Athens (UTC+3 summer).
function dayNightDraft(over: Partial<TariffDraftDto> = {}): TariffDraftDto {
  return {
    name: 'Standard',
    isDefault: true,
    isActive: true,
    validFrom: null,
    validTo: null,
    timezone: 'Europe/Athens',
    graceMinutes: 0,
    incrementMinutes: 60,
    vehicleTypes: ['car'],
    tiers: [{ key: 't', fromMinute: 0, toMinute: null, unit: 'per_block', blockMinutes: 60 }],
    windows: [
      { key: 'day', label: 'Day', dayMask: 127, startMinute: 360, endMinute: 1320 },
      { key: 'night', label: 'Night', dayMask: 127, startMinute: 1320, endMinute: 360 },
    ],
    rates: [
      { tierKey: 't', windowKey: 'day', priceCents: 300, currency: 'EUR' },
      { tierKey: 't', windowKey: 'night', priceCents: 100, currency: 'EUR' },
    ],
    caps: [],
    ...over,
  }
}

describe('tariffDraftSchema timezone validation', () => {
  it('accepts a valid IANA zone', () => {
    expect(tariffDraftSchema.safeParse(dayNightDraft()).success).toBe(true)
  })

  it('rejects an invalid IANA zone (would persist an un-priceable plan)', () => {
    const res = tariffDraftSchema.safeParse(dayNightDraft({ timezone: 'Mars/Olympus' }))
    expect(res.success).toBe(false)
    if (!res.success) {
      expect(res.error.issues.some((i) => i.message === 'invalid IANA timezone')).toBe(true)
    }
  })
})

describe('validateRateGrid', () => {
  const tiers = [{ id: 't' }]
  const windows = [
    { id: 'day', label: 'Day' },
    { id: 'night', label: 'Night' },
  ]

  it('passes for a complete cartesian grid', () => {
    expect(() =>
      validateRateGrid(tiers, windows, [
        { tierId: 't', windowId: 'day' },
        { tierId: 't', windowId: 'night' },
      ]),
    ).not.toThrow()
  })

  it('throws naming the missing cell', () => {
    expect(() => validateRateGrid(tiers, windows, [{ tierId: 't', windowId: 'day' }])).toThrow(
      /missing rate for tier t × window Night/,
    )
  })

  it('throws on a duplicate cell', () => {
    expect(() =>
      validateRateGrid(tiers, windows, [
        { tierId: 't', windowId: 'day' },
        { tierId: 't', windowId: 'day' },
        { tierId: 't', windowId: 'night' },
      ]),
    ).toThrow(/duplicate rate/)
  })

  it('throws on a rate referencing an unknown tier', () => {
    expect(() => validateRateGrid(tiers, windows, [{ tierId: 'x', windowId: 'day' }])).toThrow(
      /unknown tier x/,
    )
  })
})

describe('TariffService admin writes', () => {
  let prisma: {
    facility: { findFirst: jest.Mock }
    tariffPlan: {
      findMany: jest.Mock
      findFirst: jest.Mock
      findFirstOrThrow: jest.Mock
      create: jest.Mock
      update: jest.Mock
      updateMany: jest.Mock
    }
    rateTier: { create: jest.Mock; deleteMany: jest.Mock }
    rateWindow: { create: jest.Mock; deleteMany: jest.Mock }
    rateCap: { createMany: jest.Mock; deleteMany: jest.Mock }
    tariffRate: { createMany: jest.Mock }
    auditLog: { create: jest.Mock }
    $transaction: jest.Mock
  }
  let scope: { resolve: jest.Mock; scopeWhere: jest.Mock }
  let service: TariffService

  function setScope(s: OperatorScope) {
    scope.resolve.mockResolvedValue(s)
    scope.scopeWhere.mockReturnValue(s.kind === 'platform' ? {} : { operatorId: s.operatorId })
  }

  function persistedPlan(over: Record<string, unknown> = {}) {
    return {
      id: 'plan1',
      facilityId: 'f1',
      name: 'Standard',
      isDefault: true,
      isActive: true,
      validFrom: null,
      validTo: null,
      timezone: 'Europe/Athens',
      graceMinutes: 0,
      incrementMinutes: 60,
      vehicleTypes: ['CAR'],
      version: 1,
      createdAt: new Date('2026-06-18T00:00:00Z'),
      updatedAt: new Date('2026-06-18T00:00:00Z'),
      tiers: [
        {
          id: 'ti-1',
          fromMinute: 0,
          toMinute: null,
          unit: 'PER_BLOCK',
          blockMinutes: 60,
          rates: [
            { tierId: 'ti-1', windowId: 'wi-1', priceCents: 300, currency: 'EUR' },
            { tierId: 'ti-1', windowId: 'wi-2', priceCents: 100, currency: 'EUR' },
          ],
        },
      ],
      windows: [
        { id: 'wi-1', label: 'Day', dayMask: 127, startMinute: 360, endMinute: 1320, rates: [] },
        { id: 'wi-2', label: 'Night', dayMask: 127, startMinute: 1320, endMinute: 360, rates: [] },
      ],
      caps: [],
      ...over,
    }
  }

  beforeEach(() => {
    let tierSeq = 0
    let windowSeq = 0
    const tx = {
      tariffPlan: {
        create: jest.fn().mockResolvedValue({ id: 'plan1', version: 1 }),
        update: jest.fn(),
        updateMany: jest.fn(),
        findFirst: jest.fn(),
        findFirstOrThrow: jest.fn(),
      },
      rateTier: {
        create: jest.fn().mockImplementation(() => {
          tierSeq += 1
          return Promise.resolve({ id: `ti-${tierSeq}` })
        }),
        deleteMany: jest.fn(),
      },
      rateWindow: {
        create: jest.fn().mockImplementation(() => {
          windowSeq += 1
          return Promise.resolve({ id: `wi-${windowSeq}` })
        }),
        deleteMany: jest.fn(),
      },
      rateCap: { createMany: jest.fn(), deleteMany: jest.fn() },
      tariffRate: { createMany: jest.fn() },
      auditLog: { create: jest.fn() },
    }
    prisma = {
      facility: { findFirst: jest.fn().mockResolvedValue({ id: 'f1' }) },
      tariffPlan: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: tx.tariffPlan.findFirst,
        findFirstOrThrow: tx.tariffPlan.findFirstOrThrow,
        create: tx.tariffPlan.create,
        update: tx.tariffPlan.update,
        updateMany: tx.tariffPlan.updateMany,
      },
      rateTier: tx.rateTier,
      rateWindow: tx.rateWindow,
      rateCap: tx.rateCap,
      tariffRate: tx.tariffRate,
      auditLog: tx.auditLog,
      $transaction: jest.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
    }
    scope = { resolve: jest.fn(), scopeWhere: jest.fn() }
    service = new TariffService(
      prisma as unknown as PrismaService,
      scope as unknown as OperatorScopeService,
    )
  })

  it('cross-operator facility returns FacilityNotFoundError (no leak)', async () => {
    setScope({ kind: 'operator', operatorId: 'op1' })
    prisma.facility.findFirst.mockResolvedValue(null)

    await expect(service.listPlans(operatorUser, 'f-other')).rejects.toBeInstanceOf(
      FacilityNotFoundError,
    )
    expect(prisma.facility.findFirst.mock.calls[0]![0].where).toEqual({
      id: 'f-other',
      operatorId: 'op1',
    })
  })

  it('create unsets other defaults, persists, and audits', async () => {
    setScope({ kind: 'operator', operatorId: 'op1' })
    prisma.tariffPlan.findFirstOrThrow.mockResolvedValue(persistedPlan())

    const result = await service.createPlan(operatorUser, 'f1', dayNightDraft())

    expect(prisma.tariffPlan.updateMany).toHaveBeenCalledWith({
      where: { facilityId: 'f1', isDefault: true },
      data: { isDefault: false },
    })
    expect(prisma.tariffPlan.create.mock.calls[0]![0].data.version).toBe(1)
    expect(prisma.tariffPlan.create.mock.calls[0]![0].data.vehicleTypes).toEqual(['CAR'])
    expect(prisma.tariffRate.createMany).toHaveBeenCalled()
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'tariff_plan.created' }) }),
    )
    expect(result.tiers[0]!.unit).toBe('per_block')
    expect(result.vehicleTypes).toEqual(['car'])
  })

  it('create rejects an incomplete rate grid with InvalidTariffScheduleError', async () => {
    setScope({ kind: 'operator', operatorId: 'op1' })
    const draft = dayNightDraft({
      rates: [{ tierKey: 't', windowKey: 'day', priceCents: 300, currency: 'EUR' }],
    })

    await expect(service.createPlan(operatorUser, 'f1', draft)).rejects.toBeInstanceOf(
      InvalidTariffScheduleError,
    )
    expect(prisma.tariffPlan.create).not.toHaveBeenCalled()
  })

  it('update bumps version and replaces the schedule', async () => {
    setScope({ kind: 'operator', operatorId: 'op1' })
    prisma.tariffPlan.findFirst.mockResolvedValue({ id: 'plan1', version: 3 })
    prisma.tariffPlan.findFirstOrThrow.mockResolvedValue(persistedPlan({ version: 4 }))

    const result = await service.updatePlan(operatorUser, 'f1', 'plan1', dayNightDraft())

    expect(prisma.rateTier.deleteMany).toHaveBeenCalledWith({ where: { planId: 'plan1' } })
    expect(prisma.rateWindow.deleteMany).toHaveBeenCalledWith({ where: { planId: 'plan1' } })
    expect(prisma.tariffPlan.update.mock.calls[0]![0].data.version).toBe(4)
    expect(result.version).toBe(4)
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'tariff_plan.updated' }) }),
    )
  })

  it('update on a plan not under the facility returns 404', async () => {
    setScope({ kind: 'operator', operatorId: 'op1' })
    prisma.tariffPlan.findFirst.mockResolvedValue(null)

    await expect(
      service.updatePlan(operatorUser, 'f1', 'plan-x', dayNightDraft()),
    ).rejects.toBeInstanceOf(FacilityNotFoundError)
  })

  it('soft delete sets isActive false and audits', async () => {
    setScope({ kind: 'operator', operatorId: 'op1' })
    prisma.tariffPlan.findFirst.mockResolvedValue({ id: 'plan1' })

    await service.softDeletePlan(operatorUser, 'f1', 'plan1')

    expect(prisma.tariffPlan.update).toHaveBeenCalledWith({
      where: { id: 'plan1' },
      data: { isActive: false },
    })
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'tariff_plan.deactivated' }),
      }),
    )
  })
})

describe('TariffService.simulate', () => {
  let prisma: { facility: { findFirst: jest.Mock } }
  let scope: { resolve: jest.Mock; scopeWhere: jest.Mock }
  let service: TariffService

  beforeEach(() => {
    prisma = { facility: { findFirst: jest.fn().mockResolvedValue({ id: 'f1' }) } }
    scope = {
      resolve: jest.fn().mockResolvedValue({ kind: 'operator', operatorId: 'op1' }),
      scopeWhere: jest.fn().mockReturnValue({ operatorId: 'op1' }),
    }
    service = new TariffService(
      prisma as unknown as PrismaService,
      scope as unknown as OperatorScopeService,
    )
  })

  it('prices a day/night draft (20:00->24:00 local = 2h day + 2h night)', async () => {
    const res = await service.simulate(operatorUser, 'f1', {
      draft: dayNightDraft(),
      startsAt: new Date('2026-06-18T17:00:00Z'),
      endsAt: new Date('2026-06-18T21:00:00Z'),
      vehicleType: 'car',
    })

    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.quote.totalCents).toBe(2 * 300 + 2 * 100)
      expect(res.quote.currency).toBe('EUR')
      expect(res.quote.lineItems).toHaveLength(2)
      expect(res.quote.lineItems[0]).toMatchObject({ label: 'Day', subtotalCents: 600 })
      expect(res.quote.lineItems[1]).toMatchObject({ label: 'Night', subtotalCents: 200 })
    }
  })

  it('returns ok:false for an incomplete rate grid', async () => {
    const res = await service.simulate(operatorUser, 'f1', {
      draft: dayNightDraft({
        rates: [{ tierKey: 't', windowKey: 'day', priceCents: 300, currency: 'EUR' }],
      }),
      startsAt: new Date('2026-06-18T17:00:00Z'),
      endsAt: new Date('2026-06-18T21:00:00Z'),
      vehicleType: 'car',
    })

    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/missing rate/)
  })

  it('returns ok:false when endsAt is not after startsAt', async () => {
    const res = await service.simulate(operatorUser, 'f1', {
      draft: dayNightDraft(),
      startsAt: new Date('2026-06-18T21:00:00Z'),
      endsAt: new Date('2026-06-18T17:00:00Z'),
      vehicleType: 'car',
    })

    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/endsAt must be after startsAt/)
  })

  it('verifies facility ownership before simulating', async () => {
    prisma.facility.findFirst.mockResolvedValue(null)

    await expect(
      service.simulate(operatorUser, 'f-other', {
        draft: dayNightDraft(),
        startsAt: new Date('2026-06-18T17:00:00Z'),
        endsAt: new Date('2026-06-18T21:00:00Z'),
        vehicleType: 'car',
      }),
    ).rejects.toBeInstanceOf(FacilityNotFoundError)
  })

  it('returns ok:false for a span exceeding the max priceable duration (DoS guard)', async () => {
    const res = await service.simulate(operatorUser, 'f1', {
      draft: dayNightDraft(),
      startsAt: new Date('2020-01-01T00:00:00Z'),
      endsAt: new Date('2030-01-01T00:00:00Z'),
      vehicleType: 'car',
    })

    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/maximum priceable duration/)
  })
})
