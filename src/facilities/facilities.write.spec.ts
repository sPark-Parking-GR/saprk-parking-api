import type { AuthUser } from '@spark/types'
import { Prisma, type FacilityKind } from '@prisma/client'
import { FacilitiesService } from './facilities.service'
import type { BookingService } from '../booking/booking.service'
import {
  OperatorScopeService,
  targetOperatorId,
  type OperatorScope,
} from '../common/authz/operator-scope.service'
import {
  FacilityAlreadyExistsError,
  FacilityDeactivationFailedError,
  FacilityFieldForbiddenError,
  FacilityHasActiveBookingsError,
  FacilityNotFoundError,
  OperatorTargetRequiredError,
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

// Rebuilds the Sql the tagged template would have produced, so a test can inspect the
// placeholder text and the bound values separately.
const sqlOf = (call: unknown[]): Prisma.Sql =>
  Prisma.sql(call[0] as readonly string[], ...call.slice(1))

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
    facilityOwnershipPeriod: { create: jest.Mock }
    tariffPlan: { findFirst: jest.Mock; findMany: jest.Mock }
    booking: { findMany: jest.Mock; count: jest.Mock; groupBy: jest.Mock }
    parkingOperator: { findUnique: jest.Mock }
    auditLog: { create: jest.Mock }
    operatorMembership: { findFirst: jest.Mock }
    $transaction: jest.Mock
    $queryRaw: jest.Mock
  }
  let scope: { resolve: jest.Mock; scopeWhere: jest.Mock }
  let bookings: { cancelBooking: jest.Mock }
  let service: FacilitiesService

  function setScope(s: OperatorScope) {
    scope.resolve.mockResolvedValue(s)
    scope.scopeWhere.mockReturnValue(
      s.kind === 'platform' ? {} : { operatorId: { in: s.operatorIds } },
    )
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
    facilityOwnershipPeriod: { create: jest.Mock }
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
      facilityOwnershipPeriod: { create: jest.fn() },
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
      booking: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      facilityOwnershipPeriod: { create: tx.facilityOwnershipPeriod.create },
      parkingOperator: { findUnique: jest.fn().mockResolvedValue({ id: 'op1' }) },
      auditLog: { create: tx.auditLog.create },
      operatorMembership: { findFirst: jest.fn() },
      $transaction: jest.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
      $queryRaw: jest.fn().mockResolvedValue([{ count: 0 }]),
    }
    scope = { resolve: jest.fn(), scopeWhere: jest.fn() }
    bookings = { cancelBooking: jest.fn() }
    service = new FacilitiesService(
      prisma as unknown as PrismaService,
      {} as unknown as InventoryService,
      {} as unknown as TariffService,
      scope as unknown as OperatorScopeService,
      bookings as unknown as BookingService,
    )
  })

  it('operator_admin create forces isActive/isVerified false and audits', async () => {
    setScope({ kind: 'operator', operatorIds: ['op1'] })
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

  it('opens an ownership period in the same transaction, or analytics never sees the money', async () => {
    setScope({ kind: 'operator', operatorIds: ['op1'] })
    const row = makeRow()
    prisma.facility.create.mockResolvedValue(row)

    await service.create(operatorUser, { ...validCreate })

    expect(tx.facilityOwnershipPeriod.create).toHaveBeenCalledWith({
      data: { facilityId: row.id, operatorId: 'op1', from: row.createdAt, to: null },
    })
  })

  it('operator create ignores a dto.operatorId and uses membership scope', async () => {
    setScope({ kind: 'operator', operatorIds: ['op1'] })
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

  it('multi-operator create without operatorId is refused, not guessed', async () => {
    setScope({ kind: 'operator', operatorIds: ['op1', 'op2'] })

    await expect(service.create(operatorUser, { ...validCreate })).rejects.toBeInstanceOf(
      OperatorTargetRequiredError,
    )
    expect(prisma.facility.create).not.toHaveBeenCalled()
  })

  it('multi-operator create uses an operatorId the caller belongs to', async () => {
    setScope({ kind: 'operator', operatorIds: ['op1', 'op2'] })
    prisma.facility.create.mockResolvedValue(makeRow({ operatorId: 'op2' }))

    await service.create(operatorUser, { ...validCreate, operatorId: 'op2' })

    expect(prisma.facility.create.mock.calls[0]![0].data.operatorId).toBe('op2')
  })

  it('multi-operator create rejects an operatorId outside the caller memberships', async () => {
    setScope({ kind: 'operator', operatorIds: ['op1', 'op2'] })

    await expect(
      service.create(operatorUser, { ...validCreate, operatorId: 'op3' }),
    ).rejects.toBeInstanceOf(OperatorTargetRequiredError)
    expect(prisma.facility.create).not.toHaveBeenCalled()
  })

  describe('one-facility-per-operator cap', () => {
    it('rejects a second create when the operator already owns a facility', async () => {
      setScope({ kind: 'operator', operatorIds: ['op1'] })
      tx.facility.count.mockResolvedValue(1)

      await expect(service.create(operatorUser, { ...validCreate })).rejects.toBeInstanceOf(
        FacilityAlreadyExistsError,
      )
      expect(tx.facility.create).not.toHaveBeenCalled()
    })

    it('locks the operator row (FOR UPDATE) before the cap count', async () => {
      setScope({ kind: 'operator', operatorIds: ['op1'] })
      prisma.facility.create.mockResolvedValue(makeRow())

      await service.create(operatorUser, { ...validCreate })

      expect(tx.$executeRaw).toHaveBeenCalled()
      const lockOrder = tx.$executeRaw.mock.invocationCallOrder[0]!
      const countOrder = tx.facility.count.mock.invocationCallOrder[0]!
      expect(lockOrder).toBeLessThan(countOrder)
    })

    it('translates a P2002 unique-violation race into FacilityAlreadyExistsError', async () => {
      setScope({ kind: 'operator', operatorIds: ['op1'] })
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
    setScope({ kind: 'operator', operatorIds: ['op1'] })
    prisma.facility.findFirst.mockResolvedValue({ id: 'f1' })

    await expect(service.update(operatorUser, 'f1', { isVerified: true })).rejects.toBeInstanceOf(
      FacilityFieldForbiddenError,
    )
  })

  it('operator update cannot set rank', async () => {
    setScope({ kind: 'operator', operatorIds: ['op1'] })
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
    setScope({ kind: 'operator', operatorIds: ['op1'] })
    prisma.facility.findFirst.mockResolvedValue(null)

    await expect(service.adminGetById(operatorUser, 'f-other')).rejects.toBeInstanceOf(
      FacilityNotFoundError,
    )
    expect(prisma.facility.findFirst.mock.calls[0]![0].where).toEqual({
      id: 'f-other',
      operatorId: { in: ['op1'] },
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
    setScope({ kind: 'operator', operatorIds: ['op1'] })
    prisma.facility.findMany.mockResolvedValue([])

    await service.adminList(operatorUser, { skip: 0, take: 20, operatorId: 'op9' })

    const where = prisma.facility.findMany.mock.calls[0]![0].where
    expect(where.operatorId).toEqual({ in: ['op1'] })
    expect(where.AND).toBeUndefined()
  })

  it('multi-operator list spans every membership and excludes any other operator', async () => {
    setScope({ kind: 'operator', operatorIds: ['op1', 'op2'] })

    await service.adminList(operatorUser, { skip: 0, take: 20 })

    const where = prisma.facility.findMany.mock.calls[0]![0].where
    expect(where.operatorId).toEqual({ in: ['op1', 'op2'] })
    expect((where.operatorId as { in: string[] }).in).not.toContain('op3')
    expect(prisma.facility.count.mock.calls[0]![0].where).toEqual(where)
  })

  describe('admin map', () => {
    const bounds = { north: 38, south: 37, east: 24, west: 23 }

    it('multi-operator map spans every membership in both the SQL and the Prisma path', async () => {
      setScope({ kind: 'operator', operatorIds: ['op1', 'op2'] })
      prisma.$queryRaw.mockResolvedValue([{ count: 2 }])

      await service.adminMap(operatorUser, { bounds })

      const sql = sqlOf(prisma.$queryRaw.mock.calls[0]!)
      expect(sql.text).toContain('"operatorId" IN ($5,$6)')
      expect(sql.values.slice(4)).toEqual(['op1', 'op2'])

      const where = prisma.facility.findMany.mock.calls[0]![0].where
      expect(where.AND).toContainEqual({ operatorId: { in: ['op1', 'op2'] } })
      expect(JSON.stringify(where)).not.toContain('op3')
    })

    it('ignores a requested operatorId for an operator caller', async () => {
      setScope({ kind: 'operator', operatorIds: ['op1'] })

      await service.adminMap(operatorUser, { bounds, operatorId: 'op9' })

      expect(sqlOf(prisma.$queryRaw.mock.calls[0]!).values).toEqual([23, 37, 24, 38, 'op1'])
    })

    it('binds `q` as a parameter instead of inlining it into the SQL', async () => {
      setScope({ kind: 'platform' })
      const q = `x'); DROP TABLE "Facility"; --`

      await service.adminMap(platformUser, { bounds, q })

      const sql = sqlOf(prisma.$queryRaw.mock.calls[0]!)
      expect(sql.text).toContain('("name" ILIKE $5 OR "address" ILIKE $6)')
      expect(sql.text).not.toContain('DROP TABLE')
      expect(sql.values).toEqual([23, 37, 24, 38, `%${q}%`, `%${q}%`])
    })

    it('binds kind, the boolean filters and a platform-selected operatorId', async () => {
      setScope({ kind: 'platform' })

      await service.adminMap(platformUser, {
        bounds,
        isActive: true,
        isVerified: false,
        kind: 'BUSINESS' as FacilityKind,
        operatorId: 'op9',
      })

      const sql = sqlOf(prisma.$queryRaw.mock.calls[0]!)
      expect(sql.text).toContain('"isActive" = $5')
      expect(sql.text).toContain('"isVerified" = $6')
      expect(sql.text).toContain('"kind" = $7::"FacilityKind"')
      expect(sql.text).toContain('"operatorId" IN ($8)')
      expect(sql.text).not.toContain('BUSINESS')
      expect(sql.values).toEqual([23, 37, 24, 38, true, false, 'BUSINESS', 'op9'])
    })

    it('matches bounds on the indexed geog column with longitude-first envelope args', async () => {
      setScope({ kind: 'platform' })

      await service.adminMap(platformUser, { bounds })

      const sql = sqlOf(prisma.$queryRaw.mock.calls[0]!)
      expect(sql.text).toContain(
        'ST_Intersects("geog", ST_MakeEnvelope($1, $2, $3, $4, 4326)::geography)',
      )
      expect(sql.values).toEqual([bounds.west, bounds.south, bounds.east, bounds.north])
    })

    it('returns an empty response without a second query when nothing matches', async () => {
      setScope({ kind: 'platform' })

      const res = await service.adminMap(platformUser, { bounds })

      expect(res).toEqual({ mode: 'points', points: [], clusters: [], total: 0 })
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1)
      expect(prisma.facility.findMany).not.toHaveBeenCalled()
    })

    it('buckets clusters in SQL without hydrating rows, keeping the 12x12 grid shape', async () => {
      setScope({ kind: 'platform' })
      prisma.$queryRaw.mockResolvedValueOnce([{ count: 900 }]).mockResolvedValueOnce([
        { gx: 0, gy: 0, count: 500, lat: 37.1, lng: 23.1 },
        { gx: 3, gy: 7, count: 400, lat: 37.9, lng: 23.8 },
      ])

      const res = await service.adminMap(platformUser, { bounds })

      expect(res.mode).toBe('clusters')
      expect(res.total).toBe(900)
      expect(res.clusters).toEqual([
        { id: 'c_0_0', lat: 37.1, lng: 23.1, count: 500 },
        { id: 'c_3_7', lat: 37.9, lng: 23.8, count: 400 },
      ])
      expect(prisma.facility.findMany).not.toHaveBeenCalled()

      const sql = sqlOf(prisma.$queryRaw.mock.calls[1]!)
      expect(sql.values.slice(0, 4)).toEqual([bounds.west, 1 / 12, bounds.south, 1 / 12])
    })

    it('counts and clusters through the identical predicate', async () => {
      setScope({ kind: 'operator', operatorIds: ['op1', 'op2'] })
      prisma.$queryRaw.mockResolvedValueOnce([{ count: 900 }]).mockResolvedValueOnce([])

      await service.adminMap(operatorUser, {
        bounds,
        q: 'kolonaki',
        isActive: true,
        kind: 'BUSINESS' as FacilityKind,
      })

      const countSql = sqlOf(prisma.$queryRaw.mock.calls[0]!)
      const clusterSql = sqlOf(prisma.$queryRaw.mock.calls[1]!)
      expect(clusterSql.values.slice(4)).toEqual(countSql.values)
    })

    it('feeds the Prisma points path the same filter set as the SQL predicate', async () => {
      setScope({ kind: 'operator', operatorIds: ['op1'] })
      prisma.$queryRaw.mockResolvedValue([{ count: 2 }])

      await service.adminMap(operatorUser, {
        bounds,
        q: 'kolonaki',
        isActive: true,
        isVerified: false,
        kind: 'BUSINESS' as FacilityKind,
      })

      const call = prisma.facility.findMany.mock.calls[0]![0]
      expect(call.take).toBe(250)
      expect(call.where).toEqual({
        AND: [
          { lat: { gte: 37, lte: 38 }, lng: { gte: 23, lte: 24 } },
          {
            OR: [
              { name: { contains: 'kolonaki', mode: 'insensitive' } },
              { address: { contains: 'kolonaki', mode: 'insensitive' } },
            ],
          },
          { isActive: true },
          { isVerified: false },
          { kind: 'BUSINESS' },
          { operatorId: { in: ['op1'] } },
        ],
      })
      expect(sqlOf(prisma.$queryRaw.mock.calls[0]!).values).toEqual([
        23,
        37,
        24,
        38,
        '%kolonaki%',
        '%kolonaki%',
        true,
        false,
        'BUSINESS',
        'op1',
      ])
    })
  })

  it('soft delete sets isActive false and audits', async () => {
    setScope({ kind: 'operator', operatorIds: ['op1'] })
    prisma.facility.findFirst.mockResolvedValue({ id: 'f1' })
    prisma.facility.update.mockResolvedValue(makeRow())

    await service.softDelete(operatorUser, 'f1')

    expect(prisma.facility.update).toHaveBeenCalledWith({
      where: { id: 'f1' },
      data: { isActive: false },
    })
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'facility.deactivated' }),
      }),
    )
  })

  describe('deactivation with unhonoured bookings', () => {
    const unhonoured = (...ids: string[]) =>
      prisma.booking.findMany.mockResolvedValue(ids.map((id) => ({ id })))

    beforeEach(() => {
      setScope({ kind: 'operator', operatorIds: ['op1'] })
      prisma.facility.findFirst.mockResolvedValue({ id: 'f1' })
      prisma.facility.update.mockResolvedValue(makeRow())
    })

    it('refuses to deactivate while future confirmed bookings exist, naming the count', async () => {
      unhonoured('b1', 'b2', 'b3')

      const error = await service.softDelete(operatorUser, 'f1').catch((e: Error) => e)

      expect(error).toBeInstanceOf(FacilityHasActiveBookingsError)
      expect((error as Error).message).toContain('3 booking(s)')
      expect(prisma.facility.update).not.toHaveBeenCalled()
      expect(bookings.cancelBooking).not.toHaveBeenCalled()
    })

    it('counts only unfinished CONFIRMED/CHECKED_IN bookings as blocking', async () => {
      unhonoured('b1')

      await service.softDelete(operatorUser, 'f1').catch(() => undefined)

      const where = prisma.booking.findMany.mock.calls[0]![0].where
      expect(where.facilityId).toBe('f1')
      expect(where.status).toEqual({ in: ['CONFIRMED', 'CHECKED_IN'] })
      expect(where.endsAt.gt).toBeInstanceOf(Date)
    })

    it('force cancels and refunds each blocking booking through the existing refund path', async () => {
      unhonoured('b1', 'b2')

      await service.softDelete(operatorUser, 'f1', true)

      expect(bookings.cancelBooking.mock.calls.map((c) => c[0])).toEqual(['b1', 'b2'])
      expect(bookings.cancelBooking).toHaveBeenCalledWith('b1', operatorUser)
      expect(prisma.facility.update).toHaveBeenCalledWith({
        where: { id: 'f1' },
        data: { isActive: false },
      })
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'facility.deactivated',
            payload: { forced: true, cancelledBookings: 2 },
          }),
        }),
      )
    })

    it('keeps the facility active when a forced refund fails, reporting the real split', async () => {
      unhonoured('b1', 'b2', 'b3')
      bookings.cancelBooking
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('provider down'))

      const error = await service.softDelete(operatorUser, 'f1', true).catch((e: Error) => e)

      expect(error).toBeInstanceOf(FacilityDeactivationFailedError)
      expect((error as Error).message).toContain('2 booking(s) cancelled')
      expect((error as Error).message).toContain('1 failed')
      // Every booking is attempted, so the caller learns the whole picture at once.
      expect(bookings.cancelBooking).toHaveBeenCalledTimes(3)
      expect(prisma.facility.update).not.toHaveBeenCalled()
    })

    it('blocks the update path from deactivating around the guard', async () => {
      prisma.booking.count.mockResolvedValue(2)

      await expect(service.update(operatorUser, 'f1', { isActive: false })).rejects.toBeInstanceOf(
        FacilityHasActiveBookingsError,
      )
      expect(prisma.facility.update).not.toHaveBeenCalled()
    })
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

  describe('bulk deactivation', () => {
    beforeEach(() => {
      setScope({ kind: 'operator', operatorIds: ['op1'] })
    })

    it('bulk delete soft-deletes the scoped facilities that owe nothing', async () => {
      prisma.facility.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }])
      prisma.facility.updateMany.mockResolvedValue({ count: 2 })

      const res = await service.bulkUpdate(operatorUser, {
        ids: ['a', 'b'],
        action: 'delete',
        force: false,
      })

      expect(res).toEqual({ affected: 2 })
      expect(prisma.facility.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['a', 'b'] }, operatorId: { in: ['op1'] } },
        data: { isActive: false },
      })
    })

    it('leaves a facility with unhonoured bookings active and reports it', async () => {
      prisma.facility.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }])
      prisma.booking.groupBy.mockResolvedValue([{ facilityId: 'b', _count: { _all: 4 } }])
      prisma.facility.updateMany.mockResolvedValue({ count: 1 })

      const res = await service.bulkUpdate(operatorUser, {
        ids: ['a', 'b'],
        action: 'disable',
        force: false,
      })

      expect(res).toEqual({
        affected: 1,
        skipped: [{ facilityId: 'b', reason: 'unhonoured_bookings', unhonoured: 4, cancelled: 0 }],
      })
      expect(prisma.facility.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['a'] }, operatorId: { in: ['op1'] } },
        data: { isActive: false },
      })
      expect(bookings.cancelBooking).not.toHaveBeenCalled()
    })

    it('reports honestly when one facility refund fails inside a bulk force', async () => {
      prisma.facility.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }])
      prisma.booking.groupBy.mockResolvedValue([
        { facilityId: 'a', _count: { _all: 1 } },
        { facilityId: 'b', _count: { _all: 2 } },
      ])
      prisma.booking.findMany
        .mockResolvedValueOnce([{ id: 'a1' }])
        .mockResolvedValueOnce([{ id: 'b1' }, { id: 'b2' }])
      bookings.cancelBooking
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('provider down'))
      prisma.facility.updateMany.mockResolvedValue({ count: 1 })

      const res = await service.bulkUpdate(operatorUser, {
        ids: ['a', 'b'],
        action: 'delete',
        force: true,
      })

      // 'a' cleared; 'b' stays ACTIVE and admits that one of its two refunds went
      // through — the money already moved must not be hidden behind a bare count.
      expect(res).toEqual({
        affected: 1,
        skipped: [{ facilityId: 'b', reason: 'refund_failed', unhonoured: 2, cancelled: 1 }],
      })
      expect(prisma.facility.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['a'] }, operatorId: { in: ['op1'] } },
        data: { isActive: false },
      })
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'facility.bulk.delete',
            entityId: '1 of 2',
          }),
        }),
      )
    })

    it('touches nothing when no id is in scope', async () => {
      prisma.facility.findMany.mockResolvedValue([])

      const res = await service.bulkUpdate(operatorUser, {
        ids: ['foreign'],
        action: 'disable',
        force: true,
      })

      expect(res).toEqual({ affected: 0 })
      expect(prisma.facility.updateMany).not.toHaveBeenCalled()
      expect(bookings.cancelBooking).not.toHaveBeenCalled()
    })
  })

  it('operator cannot bulk deploy (self-verify forbidden)', async () => {
    setScope({ kind: 'operator', operatorIds: ['op1'] })

    await expect(
      service.bulkUpdate(operatorUser, { ids: ['a'], action: 'deploy' }),
    ).rejects.toBeInstanceOf(FacilityFieldForbiddenError)
    expect(prisma.facility.updateMany).not.toHaveBeenCalled()
  })

  it('bulk enable is scoped to the operator (foreign ids cannot be touched)', async () => {
    setScope({ kind: 'operator', operatorIds: ['op1'] })
    prisma.facility.updateMany.mockResolvedValue({ count: 1 })

    await service.bulkUpdate(operatorUser, { ids: ['mine', 'foreign'], action: 'enable' })

    expect(prisma.facility.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['mine', 'foreign'] }, operatorId: { in: ['op1'] } },
      data: { isActive: true },
    })
  })

  it('operator can bulk publish own facilities (unlike deploy, this does not require platform verification)', async () => {
    setScope({ kind: 'operator', operatorIds: ['op1'] })
    prisma.facility.updateMany.mockResolvedValue({ count: 2 })

    const res = await service.bulkUpdate(operatorUser, { ids: ['a', 'b'], action: 'publish' })

    expect(res).toEqual({ affected: 2 })
    expect(prisma.facility.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['a', 'b'] }, operatorId: { in: ['op1'] } },
      data: { isVerified: true },
    })
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'facility.bulk.publish' }),
      }),
    )
  })

  it('operator can bulk unpublish own facilities', async () => {
    setScope({ kind: 'operator', operatorIds: ['op1'] })
    prisma.facility.updateMany.mockResolvedValue({ count: 1 })

    await service.bulkUpdate(operatorUser, { ids: ['a'], action: 'unpublish' })

    expect(prisma.facility.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['a'] }, operatorId: { in: ['op1'] } },
      data: { isVerified: false },
    })
  })

  describe('assignTariff (single facility, one slot)', () => {
    it('sets a concrete-vehicleType row after verifying facility + plan in scope, then audits', async () => {
      setScope({ kind: 'operator', operatorIds: ['op1'] })
      prisma.facility.findFirst.mockResolvedValue({ id: 'f1' })
      prisma.tariffPlan.findFirst.mockResolvedValue({ id: 'plan1', vehicleTypes: [] })

      const res = await service.assignTariff(operatorUser, 'f1', 'CAR' as never, 'plan1')

      expect(prisma.facility.findFirst.mock.calls[0]![0].where).toEqual({
        id: 'f1',
        operatorId: { in: ['op1'] },
      })
      expect(prisma.tariffPlan.findFirst.mock.calls[0]![0].where).toEqual({
        id: 'plan1',
        operatorId: { in: ['op1'] },
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
      setScope({ kind: 'operator', operatorIds: ['op1'] })
      prisma.facility.findFirst.mockResolvedValue({ id: 'f1' })
      prisma.tariffPlan.findFirst.mockResolvedValue({ id: 'plan1', vehicleTypes: ['TRUCK'] })

      await expect(
        service.assignTariff(operatorUser, 'f1', 'CAR' as never, 'plan1'),
      ).rejects.toBeInstanceOf(TariffAssignmentMismatchError)
      expect(tx.facilityTariffAssignment.create).not.toHaveBeenCalled()
      expect(tx.facilityTariffAssignment.deleteMany).not.toHaveBeenCalled()
    })

    it('rejects when the facility is not in the caller scope (no write)', async () => {
      setScope({ kind: 'operator', operatorIds: ['op1'] })
      prisma.facility.findFirst.mockResolvedValue(null)

      await expect(
        service.assignTariff(operatorUser, 'f-other', 'CAR' as never, 'plan1'),
      ).rejects.toBeInstanceOf(FacilityNotFoundError)
      expect(prisma.tariffPlan.findFirst).not.toHaveBeenCalled()
      expect(tx.facilityTariffAssignment.create).not.toHaveBeenCalled()
    })

    it('rejects when the plan is not in the caller scope (cross-operator leak blocked)', async () => {
      setScope({ kind: 'operator', operatorIds: ['op1'] })
      prisma.facility.findFirst.mockResolvedValue({ id: 'f1' })
      prisma.tariffPlan.findFirst.mockResolvedValue(null)

      await expect(
        service.assignTariff(operatorUser, 'f1', 'CAR' as never, 'plan-other'),
      ).rejects.toBeInstanceOf(TariffPlanNotFoundError)
      expect(tx.facilityTariffAssignment.create).not.toHaveBeenCalled()
    })

    it('clears a slot when tariffPlanId is null without a plan lookup or create', async () => {
      setScope({ kind: 'operator', operatorIds: ['op1'] })
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
      setScope({ kind: 'operator', operatorIds: ['op1'] })
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
        operatorId: { in: ['op1'] },
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
      setScope({ kind: 'operator', operatorIds: ['op1'] })
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
        operatorId: { in: ['op1'] },
      })
      expect(tx.facilityTariffAssignment.createMany).toHaveBeenCalledWith({
        data: [{ facilityId: 'mine', tariffPlanId: 'plan1', vehicleType: 'CAR' }],
      })
      expect(res).toEqual({ affected: 1 })
    })

    it('rejects the whole call when ANY plan id in the array is out of scope (no writes)', async () => {
      setScope({ kind: 'operator', operatorIds: ['op1'] })
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
      setScope({ kind: 'operator', operatorIds: ['op1'] })
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
      setScope({ kind: 'operator', operatorIds: ['op1'] })
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
      setScope({ kind: 'operator', operatorIds: ['op1'] })
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
      setScope({ kind: 'operator', operatorIds: ['op1'] })
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
      setScope({ kind: 'operator', operatorIds: ['op1'] })
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
  let prisma: { operatorMembership: { findMany: jest.Mock } }
  let svc: OperatorScopeService

  const memberships = (...ids: string[]) =>
    prisma.operatorMembership.findMany.mockResolvedValue(ids.map((operatorId) => ({ operatorId })))

  beforeEach(() => {
    prisma = { operatorMembership: { findMany: jest.fn().mockResolvedValue([]) } }
    svc = new OperatorScopeService(prisma as unknown as PrismaService)
  })

  it('platform_admin resolves to platform scope', async () => {
    await expect(svc.resolve(platformUser)).resolves.toEqual({ kind: 'platform' })
  })

  it('operator with membership resolves to operator scope', async () => {
    memberships('op1')
    await expect(svc.resolve(operatorUser)).resolves.toEqual({
      kind: 'operator',
      operatorIds: ['op1'],
    })
  })

  it('operator with several memberships resolves to all of them', async () => {
    memberships('op1', 'op2')
    await expect(svc.resolve(operatorUser)).resolves.toEqual({
      kind: 'operator',
      operatorIds: ['op1', 'op2'],
    })
    expect(prisma.operatorMembership.findMany.mock.calls[0]![0].where).toEqual({ userId: 'u-op' })
  })

  it('operator without membership is denied (403 domain error)', async () => {
    await expect(svc.resolve(operatorUser)).rejects.toThrow('No operator context for this user')
  })

  it('plain user is denied', async () => {
    const u: AuthUser = { id: 'u', email: 'u@x.gr', role: 'user', emailVerified: true }
    await expect(svc.resolve(u)).rejects.toThrow('No operator context for this user')
  })

  describe('scopeWhere', () => {
    it('filters on every operator the caller belongs to, and no other', () => {
      expect(svc.scopeWhere({ kind: 'operator', operatorIds: ['op1', 'op2'] })).toEqual({
        operatorId: { in: ['op1', 'op2'] },
      })
    })

    it('is unfiltered for platform scope', () => {
      expect(svc.scopeWhere({ kind: 'platform' })).toEqual({})
    })
  })
})

describe('targetOperatorId (create-path tenant choice)', () => {
  const multi: OperatorScope = { kind: 'operator', operatorIds: ['op1', 'op2'] }

  it('uses the single membership implicitly', () => {
    expect(targetOperatorId({ kind: 'operator', operatorIds: ['op1'] }, undefined)).toBe('op1')
  })

  it('ignores a foreign operatorId for a single-membership caller', () => {
    expect(targetOperatorId({ kind: 'operator', operatorIds: ['op1'] }, 'other-op')).toBe('op1')
  })

  it('refuses to guess for a multi-membership caller with no operatorId', () => {
    expect(() => targetOperatorId(multi, undefined)).toThrow(OperatorTargetRequiredError)
  })

  it('honours an explicit operatorId the caller belongs to', () => {
    expect(targetOperatorId(multi, 'op2')).toBe('op2')
  })

  it('refuses an operatorId the multi-membership caller does not belong to', () => {
    expect(() => targetOperatorId(multi, 'op3')).toThrow(OperatorTargetRequiredError)
  })

  it('requires platform admins to name the operator', () => {
    expect(() => targetOperatorId({ kind: 'platform' }, undefined)).toThrow('operatorId required')
    expect(targetOperatorId({ kind: 'platform' }, 'op9')).toBe('op9')
  })
})
