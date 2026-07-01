import type { AuthUser } from '@spark/types'
import { FacilitiesService } from './facilities.service'
import { OperatorScopeService, type OperatorScope } from '../common/authz/operator-scope.service'
import {
  FacilityFieldForbiddenError,
  FacilityNotFoundError,
} from '../common/errors/domain.errors'
import type { InventoryService } from '../inventory/inventory.service'
import type { PrismaService } from '../prisma/prisma.service'
import type { TariffService } from '../tariff/tariff.service'
import {
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

  beforeEach(() => {
    const tx = {
      facility: {
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      auditLog: { create: jest.fn() },
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
