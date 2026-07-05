import type { AuthUser } from '@spark/types'
import { Prisma } from '@prisma/client'
import { TariffService, assignmentMismatchReason, canBeDefault } from './tariff.service'
import type { VehicleType } from '@prisma/client'
import type { OperatorScopeService, OperatorScope } from '../common/authz/operator-scope.service'
import {
  DefaultTariffRequiredError,
  DomainError,
  InvalidTariffScheduleError,
  TariffPlanNotFoundError,
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

const platformUser: AuthUser = {
  id: 'u-pa',
  email: 'pa@spark.gr',
  role: 'platform_admin',
  emailVerified: true,
}

// Day 06:00-22:00 (360-1320), Night otherwise (wrap). Hourly blocks. Athens (UTC+3 summer).
function dayNightDraft(over: Partial<TariffDraftDto> = {}): TariffDraftDto {
  return {
    name: 'Standard',
    isActive: true,
    isDefault: false,
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
    facility: { findFirst: jest.Mock; updateMany: jest.Mock; findMany: jest.Mock; count: jest.Mock }
    facilityTariffAssignment: { findMany: jest.Mock; deleteMany: jest.Mock; groupBy: jest.Mock }
    parkingOperator: { findUnique: jest.Mock }
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
  let tx: {
    facility: { updateMany: jest.Mock }
    facilityTariffAssignment: { deleteMany: jest.Mock }
    tariffPlan: {
      create: jest.Mock
      update: jest.Mock
      updateMany: jest.Mock
      findFirst: jest.Mock
      findMany: jest.Mock
      findFirstOrThrow: jest.Mock
    }
    rateTier: { create: jest.Mock; deleteMany: jest.Mock }
    rateWindow: { create: jest.Mock; deleteMany: jest.Mock }
    rateCap: { createMany: jest.Mock; deleteMany: jest.Mock }
    tariffRate: { createMany: jest.Mock }
    auditLog: { create: jest.Mock }
  }

  function setScope(s: OperatorScope) {
    scope.resolve.mockResolvedValue(s)
    scope.scopeWhere.mockReturnValue(s.kind === 'platform' ? {} : { operatorId: s.operatorId })
  }

  function persistedPlan(over: Record<string, unknown> = {}) {
    return {
      id: 'plan1',
      operatorId: 'op1',
      name: 'Standard',
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
    // Ownership lookups (assertPlanOwned) and in-tx re-reads share one findFirst mock so
    // a test can override the plan seen by both paths at once. Default plan row is a
    // non-default active plan at version 3 (guard skipped unless a test overrides it).
    const planFindFirst = jest.fn().mockResolvedValue({
      id: 'plan1',
      version: 3,
      operatorId: 'op1',
      isActive: true,
      isDefault: false,
      vehicleTypes: [],
    })
    tx = {
      facility: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      facilityTariffAssignment: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      tariffPlan: {
        create: jest.fn().mockResolvedValue({ id: 'plan1', version: 1 }),
        update: jest.fn(),
        updateMany: jest.fn(),
        findFirst: planFindFirst,
        findMany: jest.fn().mockResolvedValue([]),
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
      facility: {
        findFirst: jest.fn().mockResolvedValue({ id: 'f1' }),
        updateMany: tx.facility.updateMany,
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      facilityTariffAssignment: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: tx.facilityTariffAssignment.deleteMany,
        groupBy: jest.fn().mockResolvedValue([]),
      },
      parkingOperator: { findUnique: jest.fn().mockResolvedValue({ id: 'op1' }) },
      tariffPlan: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: planFindFirst,
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

  it('cross-operator plan returns TariffPlanNotFoundError (no leak)', async () => {
    setScope({ kind: 'operator', operatorId: 'op1' })
    prisma.tariffPlan.findFirst.mockResolvedValue(null)

    await expect(service.getPlanDetail(operatorUser, 'plan-other')).rejects.toBeInstanceOf(
      TariffPlanNotFoundError,
    )
    expect(prisma.tariffPlan.findFirst.mock.calls[0]![0].where).toEqual({
      id: 'plan-other',
      operatorId: 'op1',
    })
  })

  it('list scopes to the caller operator', async () => {
    setScope({ kind: 'operator', operatorId: 'op1' })
    prisma.tariffPlan.findMany.mockResolvedValue([])

    await service.listPlans(operatorUser)

    expect(prisma.tariffPlan.findMany.mock.calls[0]![0].where).toEqual({ operatorId: 'op1' })
  })

  it('operator create infers operatorId from scope, persists and audits', async () => {
    setScope({ kind: 'operator', operatorId: 'op1' })
    prisma.tariffPlan.findFirstOrThrow.mockResolvedValue(persistedPlan())

    const result = await service.createPlan(operatorUser, dayNightDraft())

    expect(prisma.tariffPlan.create.mock.calls[0]![0].data.operatorId).toBe('op1')
    expect(prisma.tariffPlan.create.mock.calls[0]![0].data.version).toBe(1)
    expect(prisma.tariffPlan.create.mock.calls[0]![0].data.vehicleTypes).toEqual(['CAR'])
    expect(prisma.tariffRate.createMany).toHaveBeenCalled()
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'tariff_plan.created' }) }),
    )
    expect(result.tiers[0]!.unit).toBe('per_block')
    expect(result.vehicleTypes).toEqual(['car'])
  })

  it('operator create ignores a body operatorId and uses its scope', async () => {
    setScope({ kind: 'operator', operatorId: 'op1' })
    prisma.tariffPlan.findFirstOrThrow.mockResolvedValue(persistedPlan())

    await service.createPlan(operatorUser, dayNightDraft({ operatorId: 'other-op' }))

    expect(prisma.tariffPlan.create.mock.calls[0]![0].data.operatorId).toBe('op1')
  })

  it('platform create requires an explicit operatorId', async () => {
    setScope({ kind: 'platform' })

    await expect(service.createPlan(platformUser, dayNightDraft())).rejects.toThrow(
      'operatorId required',
    )
    expect(prisma.tariffPlan.create).not.toHaveBeenCalled()
  })

  it('platform create uses the body operatorId after checking the operator exists', async () => {
    setScope({ kind: 'platform' })
    prisma.tariffPlan.findFirstOrThrow.mockResolvedValue(persistedPlan({ operatorId: 'op9' }))

    await service.createPlan(platformUser, dayNightDraft({ operatorId: 'op9' }))

    expect(prisma.parkingOperator.findUnique).toHaveBeenCalledWith({
      where: { id: 'op9' },
      select: { id: true },
    })
    expect(prisma.tariffPlan.create.mock.calls[0]![0].data.operatorId).toBe('op9')
  })

  it('platform create rejects an unknown operatorId', async () => {
    setScope({ kind: 'platform' })
    prisma.parkingOperator.findUnique.mockResolvedValue(null)

    await expect(
      service.createPlan(platformUser, dayNightDraft({ operatorId: 'ghost' })),
    ).rejects.toThrow('operatorId required')
    expect(prisma.tariffPlan.create).not.toHaveBeenCalled()
  })

  it('create rejects an incomplete rate grid with InvalidTariffScheduleError', async () => {
    setScope({ kind: 'operator', operatorId: 'op1' })
    const draft = dayNightDraft({
      rates: [{ tierKey: 't', windowKey: 'day', priceCents: 300, currency: 'EUR' }],
    })

    await expect(service.createPlan(operatorUser, draft)).rejects.toBeInstanceOf(
      InvalidTariffScheduleError,
    )
    expect(prisma.tariffPlan.create).not.toHaveBeenCalled()
  })

  it('update bumps version and replaces the schedule', async () => {
    setScope({ kind: 'operator', operatorId: 'op1' })
    // Shared findFirst returns version 3, so the bump lands on 4.
    prisma.tariffPlan.findFirstOrThrow.mockResolvedValue(persistedPlan({ version: 4 }))

    const result = await service.updatePlan(operatorUser, 'plan1', dayNightDraft())

    expect(prisma.rateTier.deleteMany).toHaveBeenCalledWith({ where: { planId: 'plan1' } })
    expect(prisma.rateWindow.deleteMany).toHaveBeenCalledWith({ where: { planId: 'plan1' } })
    expect(prisma.tariffPlan.update.mock.calls[0]![0].data.version).toBe(4)
    expect(result.version).toBe(4)
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'tariff_plan.updated' }) }),
    )
  })

  it('update on a cross-operator plan returns 404', async () => {
    setScope({ kind: 'operator', operatorId: 'op1' })
    prisma.tariffPlan.findFirst.mockResolvedValue(null)

    await expect(
      service.updatePlan(operatorUser, 'plan-x', dayNightDraft()),
    ).rejects.toBeInstanceOf(TariffPlanNotFoundError)
  })

  it('delete removes every assignment row for the plan and deactivates in one transaction', async () => {
    setScope({ kind: 'operator', operatorId: 'op1' })

    await service.deletePlan(operatorUser, 'plan1')

    // Both writes ran inside the single $transaction callback.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(tx.facilityTariffAssignment.deleteMany).toHaveBeenCalledWith({
      where: { tariffPlanId: 'plan1' },
    })
    expect(tx.facility.updateMany).not.toHaveBeenCalled()
    expect(tx.tariffPlan.update).toHaveBeenCalledWith({
      where: { id: 'plan1' },
      data: { isActive: false },
    })
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'tariff_plan.deleted' }),
      }),
    )
  })

  it('getAssignments dedupes facilities that back the plan via multiple rows', async () => {
    setScope({ kind: 'operator', operatorId: 'op1' })
    prisma.tariffPlan.findFirst.mockResolvedValue({ id: 'plan1' })
    prisma.tariffPlan.findFirstOrThrow.mockResolvedValue({ operatorId: 'op1', isDefault: false })
    // f1 appears twice (e.g. a CAR row and a TRUCK row both point at plan1).
    prisma.facilityTariffAssignment.findMany.mockResolvedValue([
      { facility: { id: 'f2', name: 'Lot B' } },
      { facility: { id: 'f1', name: 'Lot A' } },
      { facility: { id: 'f1', name: 'Lot A' } },
    ])

    const res = await service.getAssignments(operatorUser, 'plan1')

    expect(prisma.facilityTariffAssignment.findMany.mock.calls[0]![0].where).toEqual({
      tariffPlanId: 'plan1',
    })
    // Non-default plan: no implicit-usage queries, implicitFacilityCount stays 0.
    expect(prisma.facilityTariffAssignment.groupBy).not.toHaveBeenCalled()
    expect(prisma.facility.count).not.toHaveBeenCalled()
    expect(res).toEqual({
      facilities: [
        { id: 'f1', name: 'Lot A' },
        { id: 'f2', name: 'Lot B' },
      ],
      count: 2,
      isDefault: false,
      implicitFacilityCount: 0,
    })
  })

  it('getAssignments computes implicitFacilityCount for a default plan', async () => {
    setScope({ kind: 'operator', operatorId: 'op1' })
    prisma.tariffPlan.findFirst.mockResolvedValue({ id: 'plan1' })
    prisma.tariffPlan.findFirstOrThrow.mockResolvedValue({ operatorId: 'op1', isDefault: true })
    // One explicit row on f1 (also the plan's own explicit usage).
    prisma.facilityTariffAssignment.findMany.mockResolvedValue([
      { facility: { id: 'f1', name: 'Lot A' } },
    ])
    // Operator has 3 facilities; only f1 covers all 4 vehicle types explicitly.
    prisma.facilityTariffAssignment.groupBy.mockResolvedValue([
      { facilityId: 'f1', _count: { vehicleType: 4 } },
      { facilityId: 'f2', _count: { vehicleType: 2 } },
    ])
    prisma.facility.count.mockResolvedValue(3)

    const res = await service.getAssignments(operatorUser, 'plan1')

    // 3 total - 1 fully covered = 2 facilities implicitly relying on the default.
    expect(res.isDefault).toBe(true)
    expect(res.implicitFacilityCount).toBe(2)
    expect(res.count).toBe(1)
    expect(prisma.facilityTariffAssignment.groupBy.mock.calls[0]![0].where).toEqual({
      facility: { operatorId: 'op1' },
    })
  })

  describe('canBeDefault', () => {
    const CAR = 'CAR' as VehicleType

    it('is true only when vehicleTypes is empty (catch-all)', () => {
      expect(canBeDefault([])).toBe(true)
    })

    it('is false when the plan is restricted to specific vehicle types', () => {
      expect(canBeDefault([CAR])).toBe(false)
    })
  })

  describe('createPlan default handling', () => {
    it('isDefault:true unsets any prior active default atomically before creating', async () => {
      setScope({ kind: 'operator', operatorId: 'op1' })
      prisma.tariffPlan.findFirstOrThrow.mockResolvedValue(persistedPlan({ isDefault: true }))

      await service.createPlan(operatorUser, dayNightDraft({ isDefault: true, vehicleTypes: [] }))

      expect(tx.tariffPlan.updateMany).toHaveBeenCalledWith({
        where: { operatorId: 'op1', isDefault: true },
        data: { isDefault: false },
      })
      expect(tx.tariffPlan.create.mock.calls[0]![0].data.isDefault).toBe(true)
      // The unset ran before the create.
      const unsetOrder = tx.tariffPlan.updateMany.mock.invocationCallOrder[0]!
      const createOrder = tx.tariffPlan.create.mock.invocationCallOrder[0]!
      expect(unsetOrder).toBeLessThan(createOrder)
    })

    it('isDefault:true with non-empty vehicleTypes rejects (plain 400, no write)', async () => {
      setScope({ kind: 'operator', operatorId: 'op1' })

      await expect(
        service.createPlan(operatorUser, dayNightDraft({ isDefault: true, vehicleTypes: ['car'] })),
      ).rejects.toBeInstanceOf(DomainError)
      expect(prisma.$transaction).not.toHaveBeenCalled()
      expect(tx.tariffPlan.create).not.toHaveBeenCalled()
      expect(tx.tariffPlan.updateMany).not.toHaveBeenCalled()
    })

    it('isDefault:false does not touch existing defaults', async () => {
      setScope({ kind: 'operator', operatorId: 'op1' })
      prisma.tariffPlan.findFirstOrThrow.mockResolvedValue(persistedPlan())

      await service.createPlan(operatorUser, dayNightDraft())

      expect(tx.tariffPlan.updateMany).not.toHaveBeenCalled()
      expect(tx.tariffPlan.create.mock.calls[0]![0].data.isDefault).toBe(false)
    })
  })

  describe('updatePlan / deletePlan default-removal guard', () => {
    // Make the plan being edited the operator's active default.
    function makeExistingDefault(over: Record<string, unknown> = {}) {
      return {
        id: 'plan1',
        version: 3,
        operatorId: 'op1',
        isActive: true,
        isDefault: true,
        vehicleTypes: [],
        ...over,
      }
    }

    it('update unsetting default rejects without a replacement when 2+ others remain', async () => {
      setScope({ kind: 'operator', operatorId: 'op1' })
      tx.tariffPlan.findFirst.mockResolvedValue(makeExistingDefault())
      tx.tariffPlan.findMany.mockResolvedValue([
        { id: 'p2', vehicleTypes: [] },
        { id: 'p3', vehicleTypes: [] },
      ])

      await expect(
        service.updatePlan(operatorUser, 'plan1', dayNightDraft({ isDefault: false, vehicleTypes: [] })),
      ).rejects.toBeInstanceOf(DefaultTariffRequiredError)
      expect(tx.tariffPlan.update).not.toHaveBeenCalled()
    })

    it('update unsetting default succeeds by promoting a valid replacement', async () => {
      setScope({ kind: 'operator', operatorId: 'op1' })
      tx.tariffPlan.findFirst.mockResolvedValue(makeExistingDefault())
      tx.tariffPlan.findMany.mockResolvedValue([
        { id: 'p2', vehicleTypes: [] },
        { id: 'p3', vehicleTypes: [] },
      ])
      prisma.tariffPlan.findFirstOrThrow.mockResolvedValue(persistedPlan({ isDefault: false }))

      await service.updatePlan(
        operatorUser,
        'plan1',
        dayNightDraft({ isDefault: false, vehicleTypes: [] }),
        'p2',
      )

      expect(tx.tariffPlan.update).toHaveBeenCalledWith({
        where: { id: 'p2' },
        data: { isDefault: true },
      })
    })

    it('no guard fires when only ONE other active plan remains (invariant exempt)', async () => {
      setScope({ kind: 'operator', operatorId: 'op1' })
      tx.tariffPlan.findFirst.mockResolvedValue(makeExistingDefault())
      // Deleting the default down to exactly one remaining active plan needs no replacement.
      tx.tariffPlan.findMany.mockResolvedValue([{ id: 'p2', vehicleTypes: [] }])

      await service.deletePlan(operatorUser, 'plan1')

      // p2 is NOT promoted; no replacement required.
      expect(tx.tariffPlan.update).toHaveBeenCalledWith({
        where: { id: 'plan1' },
        data: { isActive: false },
      })
      expect(
        tx.tariffPlan.update.mock.calls.some((c) => c[0].where.id === 'p2'),
      ).toBe(false)
    })

    it('delete rejects without a replacement when 2+ others remain', async () => {
      setScope({ kind: 'operator', operatorId: 'op1' })
      tx.tariffPlan.findFirst.mockResolvedValue(makeExistingDefault())
      tx.tariffPlan.findMany.mockResolvedValue([
        { id: 'p2', vehicleTypes: [] },
        { id: 'p3', vehicleTypes: [] },
      ])

      await expect(service.deletePlan(operatorUser, 'plan1')).rejects.toBeInstanceOf(
        DefaultTariffRequiredError,
      )
      expect(tx.facilityTariffAssignment.deleteMany).not.toHaveBeenCalled()
    })

    it('delete rejects a replacement candidate whose vehicleTypes is non-empty', async () => {
      setScope({ kind: 'operator', operatorId: 'op1' })
      tx.tariffPlan.findFirst.mockResolvedValue(makeExistingDefault())
      tx.tariffPlan.findMany.mockResolvedValue([
        { id: 'p2', vehicleTypes: ['CAR'] },
        { id: 'p3', vehicleTypes: [] },
      ])

      await expect(service.deletePlan(operatorUser, 'plan1', 'p2')).rejects.toBeInstanceOf(
        DomainError,
      )
      expect(tx.tariffPlan.update).not.toHaveBeenCalled()
    })

    it('delete rejects an unknown replacement candidate id', async () => {
      setScope({ kind: 'operator', operatorId: 'op1' })
      tx.tariffPlan.findFirst.mockResolvedValue(makeExistingDefault())
      tx.tariffPlan.findMany.mockResolvedValue([
        { id: 'p2', vehicleTypes: [] },
        { id: 'p3', vehicleTypes: [] },
      ])

      await expect(service.deletePlan(operatorUser, 'plan1', 'ghost')).rejects.toBeInstanceOf(
        TariffPlanNotFoundError,
      )
    })

    it('translates a P2002 on the replacement promotion into DefaultTariffRequiredError (race)', async () => {
      setScope({ kind: 'operator', operatorId: 'op1' })
      tx.tariffPlan.findFirst.mockResolvedValue(makeExistingDefault())
      tx.tariffPlan.findMany.mockResolvedValue([
        { id: 'p2', vehicleTypes: [] },
        { id: 'p3', vehicleTypes: [] },
      ])
      tx.tariffPlan.update.mockImplementation((args: { where: { id: string } }) => {
        if (args.where.id === 'p2') {
          return Promise.reject(
            new Prisma.PrismaClientKnownRequestError('unique violation', {
              code: 'P2002',
              clientVersion: 'test',
            }),
          )
        }
        return Promise.resolve(persistedPlan())
      })

      await expect(service.deletePlan(operatorUser, 'plan1', 'p2')).rejects.toBeInstanceOf(
        DefaultTariffRequiredError,
      )
    })

    it('skips the guard entirely when the edited plan is not the active default', async () => {
      setScope({ kind: 'operator', operatorId: 'op1' })
      tx.tariffPlan.findFirst.mockResolvedValue(makeExistingDefault({ isDefault: false }))

      await service.deletePlan(operatorUser, 'plan1')

      expect(tx.tariffPlan.findMany).not.toHaveBeenCalled()
      expect(tx.facilityTariffAssignment.deleteMany).toHaveBeenCalled()
    })

    it('update promoting a not-yet-default plan unsets the operator\'s current default first', async () => {
      setScope({ kind: 'operator', operatorId: 'op1' })
      tx.tariffPlan.findFirst.mockResolvedValue(
        makeExistingDefault({ id: 'plan2', isDefault: false }),
      )
      prisma.tariffPlan.findFirstOrThrow.mockResolvedValue(persistedPlan({ isDefault: true }))

      await service.updatePlan(
        operatorUser,
        'plan2',
        dayNightDraft({ isDefault: true, vehicleTypes: [] }),
      )

      expect(tx.tariffPlan.updateMany).toHaveBeenCalledWith({
        where: { operatorId: 'op1', isDefault: true, id: { not: 'plan2' } },
        data: { isDefault: false },
      })
      const unsetOrder = tx.tariffPlan.updateMany.mock.invocationCallOrder[0]!
      const updateOrder = tx.tariffPlan.update.mock.invocationCallOrder[0]!
      expect(unsetOrder).toBeLessThan(updateOrder)
    })
  })
})

describe('assignmentMismatchReason (plan/vehicleType consistency guardrail)', () => {
  const CAR = 'CAR' as VehicleType
  const TRUCK = 'TRUCK' as VehicleType

  it('accepts a concrete slot when the plan prices all types (empty vehicleTypes)', () => {
    expect(assignmentMismatchReason([], CAR)).toBeNull()
  })

  it('accepts a concrete slot the plan explicitly prices', () => {
    expect(assignmentMismatchReason([CAR, TRUCK], CAR)).toBeNull()
  })

  it('rejects a concrete slot the plan does not price', () => {
    expect(assignmentMismatchReason([TRUCK], CAR)).toMatch(/does not price/)
  })
})

describe('TariffService.simulate', () => {
  let prisma: Record<string, never>
  let scope: { resolve: jest.Mock; scopeWhere: jest.Mock }
  let service: TariffService

  beforeEach(() => {
    prisma = {}
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
    const res = await service.simulate(operatorUser, {
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

  it('resolves scope for role/tenancy consistency', async () => {
    await service.simulate(operatorUser, {
      draft: dayNightDraft(),
      startsAt: new Date('2026-06-18T17:00:00Z'),
      endsAt: new Date('2026-06-18T21:00:00Z'),
      vehicleType: 'car',
    })

    expect(scope.resolve).toHaveBeenCalledWith(operatorUser)
  })

  it('returns ok:false for an incomplete rate grid', async () => {
    const res = await service.simulate(operatorUser, {
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
    const res = await service.simulate(operatorUser, {
      draft: dayNightDraft(),
      startsAt: new Date('2026-06-18T21:00:00Z'),
      endsAt: new Date('2026-06-18T17:00:00Z'),
      vehicleType: 'car',
    })

    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/endsAt must be after startsAt/)
  })

  it('returns ok:false for a span exceeding the max priceable duration (DoS guard)', async () => {
    const res = await service.simulate(operatorUser, {
      draft: dayNightDraft(),
      startsAt: new Date('2020-01-01T00:00:00Z'),
      endsAt: new Date('2030-01-01T00:00:00Z'),
      vehicleType: 'car',
    })

    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/maximum priceable duration/)
  })
})
