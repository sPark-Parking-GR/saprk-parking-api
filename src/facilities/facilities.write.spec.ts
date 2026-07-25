import type { AuthUser } from '@spark/types'
import { Prisma } from '@prisma/client'
import { FacilitiesService } from './facilities.service'
import { OperatorScopeService, type OperatorScope } from '../common/authz/operator-scope.service'
import {
  FacilityAlreadyExistsError,
  FacilityFieldForbiddenError,
  FacilityNotFoundError,
  TariffAssignmentMismatchError,
  TariffPlanNotFoundError,
} from '../common/errors/domain.errors'
import type { InventoryService } from '../inventory/inventory.service'
import type { PrismaService } from '../prisma/prisma.service'
import type { TariffService } from '../tariff/tariff.service'
import {
  bulkFacilitySchema,
  createFacilitySchema,
  updateFacilitySchema,
  type CreateFacilityDto,
} from './dto/facility.dto'

const decimal = (n: number) => ({ toNumber: () => n }) as never

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

function makeRow(over: Record<string, unknown> = {}) {
  return {
    id: 'f1',
    operatorId: 'op1',
    name: 'Lot A',
    address: 'addr',
    lat: decimal(37.98),
    lng: decimal(23.73),
    totalCapacity: 100,
    onlineQuota: 50,
    vehicleTypes: ['CAR'],
    heightRestrictionCm: null,
    openingHoursJson: { is24h: true },
    amenities: [],
    cancellationPolicy: '',
    isActive: false,
    isVerified: false,
    rank: 0,
    createdAt: new Date('2026-06-18T00:00:00Z'),
    updatedAt: new Date('2026-06-18T00:00:00Z'),
    ...over,
  }
}

const validCreate: CreateFacilityDto = {
  name: 'Lot A',
  address: 'addr',
  lat: 37.98,
  lng: 23.73,
  totalCapacity: 100,
  onlineQuota: 50,
  vehicleTypes: ['car'],
  openingHours: { is24h: true },
  amenities: [],
  cancellationPolicy: '',
}

describe('FacilitiesService admin writes', () => {
  let prisma: {
    facility: {
      findFirst: jest.Mock
      findMany: jest.Mock
      count: jest.Mock
      create: jest.Mock
      update: jest.Mock
      updateMany: jest.Mock
    }
    facilityTariffAssignment: {
      findMany: jest.Mock
      deleteMany: jest.Mock
      create: jest.Mock
      createMany: jest.Mock
    }
    tariffPlan: { findFirst: jest.Mock; findMany: jest.Mock }
    parkingOperator: { findUnique: jest.Mock }
    auditLog: { create: jest.Mock }
    operatorMembership: { findFirst: jest.Mock }
    $transaction: jest.Mock
  }
  let scope: { resolve: jest.Mock; scopeWhere: jest.Mock }
  let service: FacilitiesService

  function setScope(s: OperatorScope) {
    scope.resolve.mockResolvedValue(s)
    scope.scopeWhere.mockReturnValue(s.kind === 'platform' ? {} : { operatorId: s.operatorId })
  }

  let tx: {
    facility: {
      create: jest.Mock
      update: jest.Mock
      updateMany: jest.Mock
      findMany: jest.Mock
      count: jest.Mock
    }
    facilityTariffAssignment: { deleteMany: jest.Mock; create: jest.Mock; createMany: jest.Mock }
    auditLog: { create: jest.Mock }
    $executeRaw: jest.Mock
  }

  beforeEach(() => {
    tx = {
      facility: {
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      facilityTariffAssignment: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn(),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      auditLog: { create: jest.fn() },
      $executeRaw: jest.fn().mockResolvedValue(0),
    }
    prisma = {
      facility: {
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        create: tx.facility.create,
        update: tx.facility.update,
        updateMany: tx.facility.updateMany,
      },
      facilityTariffAssignment: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: tx.facilityTariffAssignment.deleteMany,
        create: tx.facilityTariffAssignment.create,
        createMany: tx.facilityTariffAssignment.createMany,
      },
      tariffPlan: {
        findFirst: jest.fn().mockResolvedValue({ id: 'plan1', vehicleTypes: [] }),
        findMany: jest.fn().mockResolvedValue([{ id: 'plan1', vehicleTypes: [] }]),
      },
      parkingOperator: { findUnique: jest.fn().mockResolvedValue({ id: 'op1' }) },
      auditLog: { create: tx.auditLog.create },
      operatorMembership: { findFirst: jest.fn() },
      $transaction: jest.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
    }
    scope = { resolve: jest.fn(), scopeWhere: jest.fn() }
    service = new FacilitiesService(
      prisma as unknown as PrismaService,
      {} as unknown as InventoryService,
      {} as unknown as TariffService,
      scope as unknown as OperatorScopeService,
    )
  })

  it('operator_admin create forces isActive/isVerified false and audits', async () => {
    setScope({ kind: 'operator', operatorId: 'op1' })
    prisma.facility.create.mockResolvedValue(makeRow())

    await service.create(operatorUser, { ...validCreate })

    const data = prisma.facility.create.mock.calls[0]![0].data
    expect(data.isActive).toBe(false)
    expect(data.isVerified).toBe(false)
    expect(data.rank).toBe(0)
    expect(data.operatorId).toBe('op1')
    expect(data.vehicleTypes).toEqual(['CAR'])
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'facility.created' }) }),
    )
  })

  it('operator create ignores a dto.operatorId and uses membership scope', async () => {
    setScope({ kind: 'operator', operatorId: 'op1' })
    prisma.facility.create.mockResolvedValue(makeRow())

    await service.create(operatorUser, { ...validCreate, operatorId: 'other-op' })

    expect(prisma.facility.create.mock.calls[0]![0].data.operatorId).toBe('op1')
  })

  it('platform create requires operatorId', async () => {
    setScope({ kind: 'platform' })

    await expect(service.create(platformUser, { ...validCreate })).rejects.toThrow(
      'operatorId required',
    )
  })

  describe('one-facility-per-operator cap', () => {
    it('rejects a second create when the operator already owns a facility', async () => {
      setScope({ kind: 'operator', operatorId: 'op1' })
      tx.facility.count.mockResolvedValue(1)

      await expect(service.create(operatorUser, { ...validCreate })).rejects.toBeInstanceOf(
        FacilityAlreadyExistsError,
      )
      expect(tx.facility.create).not.toHaveBeenCalled()
    })

    it('locks the operator row (FOR UPDATE) before the cap count', async () => {
      setScope({ kind: 'operator', operatorId: 'op1' })
      prisma.facility.create.mockResolvedValue(makeRow())

      await service.create(operatorUser, { ...validCreate })

      expect(tx.$executeRaw).toHaveBeenCalled()
      const lockOrder = tx.$executeRaw.mock.invocationCallOrder[0]!
      const countOrder = tx.facility.count.mock.invocationCallOrder[0]!
      expect(lockOrder).toBeLessThan(countOrder)
    })

    it('translates a P2002 unique-violation race into FacilityAlreadyExistsError', async () => {
      setScope({ kind: 'operator', operatorId: 'op1' })
      tx.facility.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      )

      await expect(service.create(operatorUser, { ...validCreate })).rejects.toBeInstanceOf(
        FacilityAlreadyExistsError,
      )
    })
  })

  it('operator update cannot set isVerified', async () => {
    setScope({ kind: 'operator', operatorId: 'op1' })
    prisma.facility.findFirst.mockResolvedValue({ id: 'f1' })

    await expect(service.update(operatorUser, 'f1', { isVerified: true })).rejects.toBeInstanceOf(
      FacilityFieldForbiddenError,
    )
  })

  it('operator update cannot set rank', async () => {
    setScope({ kind: 'operator', operatorId: 'op1' })
    prisma.facility.findFirst.mockResolvedValue({ id: 'f1' })

    await expect(service.update(operatorUser, 'f1', { rank: 9 })).rejects.toBeInstanceOf(
      FacilityFieldForbiddenError,
    )
  })

  it('platform update may set isVerified', async () => {
    setScope({ kind: 'platform' })
    prisma.facility.findFirst.mockResolvedValue({ id: 'f1' })
    prisma.facility.update.mockResolvedValue(makeRow({ isVerified: true }))

    const res = await service.update(platformUser, 'f1', { isVerified: true })

    expect(prisma.facility.update.mock.calls[0]![0].data.isVerified).toBe(true)
    expect(res.isVerified).toBe(true)
  })

  it('cross-operator access returns FacilityNotFoundError (no leak)', async () => {
    setScope({ kind: 'operator', operatorId: 'op1' })
    prisma.facility.findFirst.mockResolvedValue(null)

    await expect(service.adminGetById(operatorUser, 'f-other')).rejects.toBeInstanceOf(
      FacilityNotFoundError,
    )
    expect(prisma.facility.findFirst.mock.calls[0]![0].where).toEqual({
      id: 'f-other',
      operatorId: 'op1',
    })
  })

  it('platform list applies no operator scope and may filter by operatorId', async () => {
    setScope({ kind: 'platform' })
    prisma.facility.findMany.mockResolvedValue([])
    prisma.facility.count.mockResolvedValue(0)

    await service.adminList(platformUser, { skip: 0, take: 20, operatorId: 'op9' })

    const where = prisma.facility.findMany.mock.calls[0]![0].where
    expect(where.operatorId).toBeUndefined()
    expect(where.AND).toEqual([{ operatorId: 'op9' }])
  })

  it('operator list ignores query.operatorId and forces its own scope', async () => {
    setScope({ kind: 'operator', operatorId: 'op1' })
    prisma.facility.findMany.mockResolvedValue([])

    await service.adminList(operatorUser, { skip: 0, take: 20, operatorId: 'op9' })

    const where = prisma.facility.findMany.mock.calls[0]![0].where
    expect(where.operatorId).toBe('op1')
    expect(where.AND).toBeUndefined()
  })

  it('soft delete sets isActive false and audits', async () => {
    setScope({ kind: 'operator', operatorId: 'op1' })
    prisma.facility.findFirst.mockResolvedValue({ id: 'f1' })
    prisma.facility.update.mockResolvedValue(makeRow())

    await service.softDelete(operatorUser, 'f1')

    expect(prisma.facility.update).toHaveBeenCalledWith({
      where: { id: 'f1' },
      data: { isActive: false },
    })
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'facility.deactivated' }) }),
    )
  })

  it('admin list exposes kind and operator name', async () => {
    setScope({ kind: 'platform' })
    prisma.facility.findMany.mockResolvedValue([
      makeRow({ kind: 'BUSINESS', source: 'GOOGLE', operator: { name: 'Acme Parking' } }),
    ])
    prisma.facility.count.mockResolvedValue(1)

    const res = await service.adminList(platformUser, { skip: 0, take: 20 })

    expect(prisma.facility.findMany.mock.calls[0]![0].select.operator).toEqual({
      select: { name: true },
    })
    expect(res.items[0]).toMatchObject({
      kind: 'BUSINESS',
      source: 'GOOGLE',
      operatorName: 'Acme Parking',
    })
    expect((res.items[0] as unknown as { operator?: unknown }).operator).toBeUndefined()
  })

  it('admin list filters by kind', async () => {
    setScope({ kind: 'platform' })

    await service.adminList(platformUser, { skip: 0, take: 20, kind: 'UNKNOWN' })

    const where = prisma.facility.findMany.mock.calls[0]![0].where
    expect(where.AND).toEqual([{ kind: 'UNKNOWN' }])
  })

  it('bulk deploy activates and verifies scoped rows and audits', async () => {
    setScope({ kind: 'platform' })
    prisma.facility.updateMany.mockResolvedValue({ count: 3 })

    const res = await service.bulkUpdate(platformUser, {
      ids: ['a', 'b', 'c'],
      action: 'deploy',
    })

    expect(res).toEqual({ affected: 3 })
    expect(prisma.facility.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['a', 'b', 'c'] } },
      data: { isActive: true, isVerified: true },
    })
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'facility.bulk.deploy' }),
      }),
    )
  })

  it('bulk delete soft-deletes (isActive false)', async () => {
    setScope({ kind: 'operator', operatorId: 'op1' })
    prisma.facility.updateMany.mockResolvedValue({ count: 2 })

    await service.bulkUpdate(operatorUser, { ids: ['a', 'b'], action: 'delete' })

    expect(prisma.facility.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['a', 'b'] }, operatorId: 'op1' },
      data: { isActive: false },
    })
  })

  it('operator cannot bulk deploy (self-verify forbidden)', async () => {
    setScope({ kind: 'operator', operatorId: 'op1' })

    await expect(
      service.bulkUpdate(operatorUser, { ids: ['a'], action: 'deploy' }),
    ).rejects.toBeInstanceOf(FacilityFieldForbiddenError)
    expect(prisma.facility.updateMany).not.toHaveBeenCalled()
  })

  it('bulk enable is scoped to the operator (foreign ids cannot be touched)', async () => {
    setScope({ kind: 'operator', operatorId: 'op1' })
    prisma.facility.updateMany.mockResolvedValue({ count: 1 })

    await service.bulkUpdate(operatorUser, { ids: ['mine', 'foreign'], action: 'enable' })

    expect(prisma.facility.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['mine', 'foreign'] }, operatorId: 'op1' },
      data: { isActive: true },
    })
  })

  describe('assignTariff (single facility, one slot)', () => {
    it('sets a concrete-vehicleType row after verifying facility + plan in scope, then audits', async () => {
      setScope({ kind: 'operator', operatorId: 'op1' })
      prisma.facility.findFirst.mockResolvedValue({ id: 'f1' })
      prisma.tariffPlan.findFirst.mockResolvedValue({ id: 'plan1', vehicleTypes: [] })

      const res = await service.assignTariff(operatorUser, 'f1', 'CAR' as never, 'plan1')

      expect(prisma.facility.findFirst.mock.calls[0]![0].where).toEqual({
        id: 'f1',
        operatorId: 'op1',
      })
      expect(prisma.tariffPlan.findFirst.mock.calls[0]![0].where).toEqual({
        id: 'plan1',
        operatorId: 'op1',
      })
      expect(tx.facilityTariffAssignment.deleteMany).toHaveBeenCalledWith({
        where: { facilityId: 'f1', vehicleType: 'CAR' },
      })
      expect(tx.facilityTariffAssignment.create).toHaveBeenCalledWith({
        data: { facilityId: 'f1', tariffPlanId: 'plan1', vehicleType: 'CAR' },
      })
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'facility.tariff_assigned',
            payload: { vehicleType: 'CAR', tariffPlanId: 'plan1' },
          }),
        }),
      )
      expect(res).toEqual({ facilityId: 'f1', vehicleType: 'CAR', tariffPlanId: 'plan1' })
    })

    it('rejects a concrete slot the plan does not price (consistency guardrail)', async () => {
      setScope({ kind: 'operator', operatorId: 'op1' })
      prisma.facility.findFirst.mockResolvedValue({ id: 'f1' })
      prisma.tariffPlan.findFirst.mockResolvedValue({ id: 'plan1', vehicleTypes: ['TRUCK'] })

      await expect(
        service.assignTariff(operatorUser, 'f1', 'CAR' as never, 'plan1'),
      ).rejects.toBeInstanceOf(TariffAssignmentMismatchError)
      expect(tx.facilityTariffAssignment.create).not.toHaveBeenCalled()
      expect(tx.facilityTariffAssignment.deleteMany).not.toHaveBeenCalled()
    })

    it('rejects when the facility is not in the caller scope (no write)', async () => {
      setScope({ kind: 'operator', operatorId: 'op1' })
      prisma.facility.findFirst.mockResolvedValue(null)

      await expect(
        service.assignTariff(operatorUser, 'f-other', 'CAR' as never, 'plan1'),
      ).rejects.toBeInstanceOf(FacilityNotFoundError)
      expect(prisma.tariffPlan.findFirst).not.toHaveBeenCalled()
      expect(tx.facilityTariffAssignment.create).not.toHaveBeenCalled()
    })

    it('rejects when the plan is not in the caller scope (cross-operator leak blocked)', async () => {
      setScope({ kind: 'operator', operatorId: 'op1' })
      prisma.facility.findFirst.mockResolvedValue({ id: 'f1' })
      prisma.tariffPlan.findFirst.mockResolvedValue(null)

      await expect(
        service.assignTariff(operatorUser, 'f1', 'CAR' as never, 'plan-other'),
      ).rejects.toBeInstanceOf(TariffPlanNotFoundError)
      expect(tx.facilityTariffAssignment.create).not.toHaveBeenCalled()
    })

    it('clears a slot when tariffPlanId is null without a plan lookup or create', async () => {
      setScope({ kind: 'operator', operatorId: 'op1' })
      prisma.facility.findFirst.mockResolvedValue({ id: 'f1' })

      await service.assignTariff(operatorUser, 'f1', 'CAR' as never, null)

      expect(prisma.tariffPlan.findFirst).not.toHaveBeenCalled()
      expect(tx.facilityTariffAssignment.deleteMany).toHaveBeenCalledWith({
        where: { facilityId: 'f1', vehicleType: 'CAR' },
      })
      expect(tx.facilityTariffAssignment.create).not.toHaveBeenCalled()
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'facility.tariff_unassigned' }),
        }),
      )
    })
  })

  describe('bulkUpdate assignTariff', () => {
    it('assigns multiple slots across scoped facilities after validating every plan', async () => {
      setScope({ kind: 'operator', operatorId: 'op1' })
      prisma.tariffPlan.findMany.mockResolvedValue([
        { id: 'planCar', vehicleTypes: ['CAR'] },
        { id: 'planTruck', vehicleTypes: [] },
      ])
      tx.facility.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }])

      const res = await service.bulkUpdate(operatorUser, {
        action: 'assignTariff',
        ids: ['a', 'b'],
        assignments: [
          { vehicleType: 'CAR' as never, tariffPlanId: 'planCar' },
          { vehicleType: 'TRUCK' as never, tariffPlanId: 'planTruck' },
        ],
      })

      // Every distinct plan id was ownership-checked in one query.
      expect(prisma.tariffPlan.findMany.mock.calls[0]![0].where).toEqual({
        id: { in: ['planCar', 'planTruck'] },
        operatorId: 'op1',
      })
      // One deleteMany clearing both targeted concrete slots on both scoped facilities.
      expect(tx.facilityTariffAssignment.deleteMany).toHaveBeenCalledWith({
        where: {
          facilityId: { in: ['a', 'b'] },
          vehicleType: { in: ['CAR', 'TRUCK'] },
        },
      })
      // One createMany inserting every facility × non-null-plan pair.
      expect(tx.facilityTariffAssignment.createMany).toHaveBeenCalledWith({
        data: [
          { facilityId: 'a', tariffPlanId: 'planCar', vehicleType: 'CAR' },
          { facilityId: 'a', tariffPlanId: 'planTruck', vehicleType: 'TRUCK' },
          { facilityId: 'b', tariffPlanId: 'planCar', vehicleType: 'CAR' },
          { facilityId: 'b', tariffPlanId: 'planTruck', vehicleType: 'TRUCK' },
        ],
      })
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'facility.bulk.assignTariff' }),
        }),
      )
      expect(res).toEqual({ affected: 2 })
    })

    it('only in-scope facilities are affected; foreign ids are silently excluded', async () => {
      setScope({ kind: 'operator', operatorId: 'op1' })
      prisma.tariffPlan.findMany.mockResolvedValue([{ id: 'plan1', vehicleTypes: [] }])
      // Only 'mine' matches id IN (...) AND operatorId = op1.
      tx.facility.findMany.mockResolvedValue([{ id: 'mine' }])

      const res = await service.bulkUpdate(operatorUser, {
        action: 'assignTariff',
        ids: ['mine', 'foreign'],
        assignments: [{ vehicleType: 'CAR' as never, tariffPlanId: 'plan1' }],
      })

      expect(tx.facility.findMany.mock.calls[0]![0].where).toEqual({
        id: { in: ['mine', 'foreign'] },
        operatorId: 'op1',
      })
      expect(tx.facilityTariffAssignment.createMany).toHaveBeenCalledWith({
        data: [{ facilityId: 'mine', tariffPlanId: 'plan1', vehicleType: 'CAR' }],
      })
      expect(res).toEqual({ affected: 1 })
    })

    it('rejects the whole call when ANY plan id in the array is out of scope (no writes)', async () => {
      setScope({ kind: 'operator', operatorId: 'op1' })
      // Caller owns planMine but not planOther; findMany returns only the owned one.
      prisma.tariffPlan.findMany.mockResolvedValue([{ id: 'planMine', vehicleTypes: [] }])

      await expect(
        service.bulkUpdate(operatorUser, {
          action: 'assignTariff',
          ids: ['a'],
          assignments: [
            { vehicleType: 'CAR' as never, tariffPlanId: 'planMine' },
            { vehicleType: 'TRUCK' as never, tariffPlanId: 'planOther' },
          ],
        }),
      ).rejects.toBeInstanceOf(TariffPlanNotFoundError)
      expect(tx.facility.findMany).not.toHaveBeenCalled()
      expect(tx.facilityTariffAssignment.deleteMany).not.toHaveBeenCalled()
      expect(tx.facilityTariffAssignment.createMany).not.toHaveBeenCalled()
    })

    it('bulk clear (all null plans) deletes the targeted slots and inserts nothing', async () => {
      setScope({ kind: 'operator', operatorId: 'op1' })
      tx.facility.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }])

      await service.bulkUpdate(operatorUser, {
        action: 'assignTariff',
        ids: ['a', 'b'],
        assignments: [{ vehicleType: 'CAR' as never, tariffPlanId: null }],
      })

      expect(prisma.tariffPlan.findMany).not.toHaveBeenCalled()
      expect(tx.facilityTariffAssignment.deleteMany).toHaveBeenCalledWith({
        where: { facilityId: { in: ['a', 'b'] }, vehicleType: { in: ['CAR'] } },
      })
      expect(tx.facilityTariffAssignment.createMany).not.toHaveBeenCalled()
    })

    it('rejects a duplicate vehicleType within one assignments array (DTO refine)', () => {
      const res = bulkFacilitySchema.safeParse({
        action: 'assignTariff',
        ids: ['a'],
        assignments: [
          { vehicleType: 'CAR', tariffPlanId: 'p1' },
          { vehicleType: 'CAR', tariffPlanId: 'p2' },
        ],
      })
      expect(res.success).toBe(false)
    })

    it('rejects a null vehicleType in an assignment row (wildcard slot is gone)', () => {
      const res = bulkFacilitySchema.safeParse({
        action: 'assignTariff',
        ids: ['a'],
        assignments: [{ vehicleType: null, tariffPlanId: 'p1' }],
      })
      expect(res.success).toBe(false)
    })
  })

  describe('getTariffAssignments (resolved 4-row view)', () => {
    const ALL_TYPES = ['CAR', 'MOTORCYCLE', 'VAN', 'TRUCK']

    it('sources all 4 rows from the operator default when there are no explicit rows', async () => {
      setScope({ kind: 'operator', operatorId: 'op1' })
      prisma.facility.findFirst.mockResolvedValue({ id: 'f1', operatorId: 'op1' })
      prisma.facilityTariffAssignment.findMany.mockResolvedValue([])
      prisma.tariffPlan.findFirst.mockResolvedValue({ id: 'def', name: 'Default' })

      const res = await service.getTariffAssignments(operatorUser, 'f1')

      expect(res.defaultPlan).toEqual({ id: 'def', name: 'Default' })
      expect(res.assignments).toHaveLength(4)
      expect(res.assignments.map((a) => a.vehicleType).sort()).toEqual([...ALL_TYPES].sort())
      for (const a of res.assignments) {
        expect(a.source).toBe('default')
        expect(a.tariffPlanId).toBe('def')
        expect(a.tariffPlanName).toBe('Default')
      }
    })

    it('sources all 4 rows as none (null ids) when there is neither explicit rows nor a default', async () => {
      setScope({ kind: 'operator', operatorId: 'op1' })
      prisma.facility.findFirst.mockResolvedValue({ id: 'f1', operatorId: 'op1' })
      prisma.facilityTariffAssignment.findMany.mockResolvedValue([])
      prisma.tariffPlan.findFirst.mockResolvedValue(null)

      const res = await service.getTariffAssignments(operatorUser, 'f1')

      expect(res.defaultPlan).toBeNull()
      expect(res.assignments).toHaveLength(4)
      for (const a of res.assignments) {
        expect(a.source).toBe('none')
        expect(a.tariffPlanId).toBeNull()
        expect(a.tariffPlanName).toBeNull()
      }
    })

    it('mixes explicit rows with default-covered rows', async () => {
      setScope({ kind: 'operator', operatorId: 'op1' })
      prisma.facility.findFirst.mockResolvedValue({ id: 'f1', operatorId: 'op1' })
      prisma.facilityTariffAssignment.findMany.mockResolvedValue([
        { vehicleType: 'CAR', tariffPlanId: 'planCar', tariffPlan: { name: 'Car Plan' } },
      ])
      prisma.tariffPlan.findFirst.mockResolvedValue({ id: 'def', name: 'Default' })

      const res = await service.getTariffAssignments(operatorUser, 'f1')

      const byType = new Map(res.assignments.map((a) => [a.vehicleType, a]))
      expect(byType.get('CAR' as never)).toEqual({
        vehicleType: 'CAR',
        tariffPlanId: 'planCar',
        tariffPlanName: 'Car Plan',
        source: 'explicit',
      })
      expect(byType.get('TRUCK' as never)!.source).toBe('default')
      expect(byType.get('TRUCK' as never)!.tariffPlanId).toBe('def')
    })

    it('rejects a facility outside the caller scope', async () => {
      setScope({ kind: 'operator', operatorId: 'op1' })
      prisma.facility.findFirst.mockResolvedValue(null)

      await expect(service.getTariffAssignments(operatorUser, 'f-other')).rejects.toBeInstanceOf(
        FacilityNotFoundError,
      )
    })
  })
})

describe('facility DTO validation', () => {
  it('rejects onlineQuota greater than totalCapacity on create', () => {
    const res = createFacilitySchema.safeParse({
      ...validCreate,
      totalCapacity: 10,
      onlineQuota: 50,
    })
    expect(res.success).toBe(false)
  })

  it('rejects an empty update object', () => {
    expect(updateFacilitySchema.safeParse({}).success).toBe(false)
  })

  it('defaults amenities and cancellationPolicy on create', () => {
    const res = createFacilitySchema.safeParse({
      name: 'X',
      address: 'a',
      lat: 0,
      lng: 0,
      totalCapacity: 5,
      onlineQuota: 5,
      vehicleTypes: ['car'],
      openingHours: { is24h: true },
    })
    expect(res.success).toBe(true)
    if (res.success) {
      expect(res.data.amenities).toEqual([])
      expect(res.data.cancellationPolicy).toBe('')
    }
  })
})

describe('OperatorScopeService', () => {
  let prisma: { operatorMembership: { findFirst: jest.Mock } }
  let svc: OperatorScopeService

  beforeEach(() => {
    prisma = { operatorMembership: { findFirst: jest.fn() } }
    svc = new OperatorScopeService(prisma as unknown as PrismaService)
  })

  it('platform_admin resolves to platform scope', async () => {
    await expect(svc.resolve(platformUser)).resolves.toEqual({ kind: 'platform' })
  })

  it('operator with membership resolves to operator scope', async () => {
    prisma.operatorMembership.findFirst.mockResolvedValue({ operatorId: 'op1' })
    await expect(svc.resolve(operatorUser)).resolves.toEqual({ kind: 'operator', operatorId: 'op1' })
  })

  it('operator without membership is denied (403 domain error)', async () => {
    prisma.operatorMembership.findFirst.mockResolvedValue(null)
    await expect(svc.resolve(operatorUser)).rejects.toThrow('No operator context for this user')
  })

  it('plain user is denied', async () => {
    const u: AuthUser = { id: 'u', email: 'u@x.gr', role: 'user', emailVerified: true }
    await expect(svc.resolve(u)).rejects.toThrow('No operator context for this user')
  })
})
