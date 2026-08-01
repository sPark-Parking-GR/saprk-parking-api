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
  EntitlementLimitExceededError,
  FacilityDeactivationFailedError,
  FacilityFieldForbiddenError,
  FacilityHasActiveBookingsError,
  FacilityKindChangeBlockedError,
  FacilityNotFoundError,
  OperatorTargetRequiredError,
  TariffAssignmentMismatchError,
  TariffPlanNotFoundError,
} from '../common/errors/domain.errors'
import type { InventoryService } from '../inventory/inventory.service'
import type { LifecycleService } from '../lifecycle/lifecycle.service'
import type { PrismaService } from '../prisma/prisma.service'
import type { EntitlementService } from '../subscriptions/entitlement.service'
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

// The narrowing term every operator-facing facility/plan query must now carry. Written out
// here so an assertion that lost it reads as a missing clause rather than a shape change.
const managed = (operatorIds: string[], userId: string) => ({
  operatorId: { in: operatorIds },
  managers: { some: { userId } },
})

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
  // The REAL scope service, with only `resolve` stubbed. The where-builders are pure and
  // security-critical, so mirroring them in a mock would let the predicate the tests assert
  // on drift away from the one production runs.
  let scope: OperatorScopeService
  let bookings: { cancelBooking: jest.Mock }
  let entitlements: { assertCanCreateFacility: jest.Mock }
  let lifecycle: { archiveFacility: jest.Mock }
  let service: FacilitiesService

  function setScope(s: OperatorScope) {
    jest.spyOn(scope, 'resolve').mockResolvedValue(s)
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
    facilityManager: { createMany: jest.Mock }
    operatorMembership: { findMany: jest.Mock }
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
      facilityManager: { createMany: jest.fn() },
      operatorMembership: { findMany: jest.fn().mockResolvedValue([]) },
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
    scope = new OperatorScopeService(prisma as unknown as PrismaService)
    bookings = { cancelBooking: jest.fn() }
    entitlements = { assertCanCreateFacility: jest.fn().mockResolvedValue(undefined) }
    lifecycle = { archiveFacility: jest.fn().mockResolvedValue(undefined) }
    service = new FacilitiesService(
      prisma as unknown as PrismaService,
      {} as unknown as InventoryService,
      {} as unknown as TariffService,
      scope,
      bookings as unknown as BookingService,
      entitlements as unknown as EntitlementService,
      lifecycle as unknown as LifecycleService,
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

  it('auto-assigns the creator as manager in the create transaction', async () => {
    setScope({ kind: 'operator', operatorIds: ['op1'] })
    const row = makeRow()
    prisma.facility.create.mockResolvedValue(row)

    await service.create(operatorUser, { ...validCreate })

    expect(tx.facilityManager.createMany).toHaveBeenCalledWith({
      data: [{ facilityId: row.id, userId: operatorUser.id, assignedBy: operatorUser.id }],
    })
  })

  /**
   * A platform admin creating on a tenant's behalf gets no row of their own — they see
   * everything already — but the facility must not land unmanaged, or the operator it was
   * created FOR could not see it.
   */
  it('seeds a platform creator’s facility to the operator’s admins, not to themselves', async () => {
    setScope({ kind: 'platform' })
    const row = makeRow()
    prisma.facility.create.mockResolvedValue(row)
    tx.operatorMembership.findMany.mockResolvedValue([{ userId: 'u-a' }, { userId: 'u-b' }])

    await service.create(platformUser, { ...validCreate, operatorId: 'op1' })

    expect(tx.facilityManager.createMany).toHaveBeenCalledWith({
      data: [
        { facilityId: row.id, userId: 'u-a', assignedBy: platformUser.id },
        { facilityId: row.id, userId: 'u-b', assignedBy: platformUser.id },
      ],
    })
  })

  it('writes no manager row when the target operator has no eligible admins', async () => {
    setScope({ kind: 'platform' })
    prisma.facility.create.mockResolvedValue(makeRow())
    tx.operatorMembership.findMany.mockResolvedValue([])

    await service.create(platformUser, { ...validCreate, operatorId: 'op1' })

    expect(tx.facilityManager.createMany).not.toHaveBeenCalled()
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

  /**
   * These were the one-facility-per-operator cap tests. The cap is gone — the limit is now
   * whatever the operator's plan grants — so they assert the same three properties against
   * its replacement rather than being deleted: the refusal happens, it happens under the
   * operator row lock, and it happens before anything is written.
   */
  describe('facility quota', () => {
    it('refuses a create the entitlement service rejects, with the entitlement error', async () => {
      setScope({ kind: 'operator', operatorIds: ['op1'] })
      entitlements.assertCanCreateFacility.mockRejectedValue(
        new EntitlementLimitExceededError('facilities', 1, 1),
      )

      await expect(service.create(operatorUser, { ...validCreate })).rejects.toBeInstanceOf(
        EntitlementLimitExceededError,
      )
      expect(tx.facility.create).not.toHaveBeenCalled()
    })

    // The dropped unique index used to be the backstop for a check-then-act race. This
    // ordering IS the replacement guarantee, so it is asserted rather than assumed.
    it('locks the operator row (FOR UPDATE) before the quota check', async () => {
      setScope({ kind: 'operator', operatorIds: ['op1'] })
      prisma.facility.create.mockResolvedValue(makeRow())

      await service.create(operatorUser, { ...validCreate })

      expect(tx.$executeRaw).toHaveBeenCalled()
      const lockOrder = tx.$executeRaw.mock.invocationCallOrder[0]!
      const assertOrder = entitlements.assertCanCreateFacility.mock.invocationCallOrder[0]!
      expect(lockOrder).toBeLessThan(assertOrder)
    })

    // The assert has to run inside the caller's transaction or the lock above buys nothing.
    it('passes the transaction client to the quota check', async () => {
      setScope({ kind: 'operator', operatorIds: ['op1'] })
      prisma.facility.create.mockResolvedValue(makeRow())

      await service.create(operatorUser, { ...validCreate })

      expect(entitlements.assertCanCreateFacility).toHaveBeenCalledWith('op1', tx)
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

  describe('facility kind (platform-admin only)', () => {
    const BUSINESS = 'BUSINESS' as FacilityKind
    const FREE_PUBLIC = 'FREE_PUBLIC' as FacilityKind

    it('operator update cannot set kind', async () => {
      setScope({ kind: 'operator', operatorIds: ['op1'] })
      prisma.facility.findFirst.mockResolvedValue({ id: 'f1', kind: BUSINESS })

      await expect(
        service.update(operatorUser, 'f1', { kind: FREE_PUBLIC }),
      ).rejects.toBeInstanceOf(FacilityFieldForbiddenError)
      expect(prisma.facility.update).not.toHaveBeenCalled()
    })

    it('platform update writes the kind and audits both the old and the new one', async () => {
      setScope({ kind: 'platform' })
      prisma.facility.findFirst.mockResolvedValue({ id: 'f1', kind: BUSINESS })
      prisma.facility.update.mockResolvedValue(makeRow({ kind: FREE_PUBLIC }))

      const res = await service.update(platformUser, 'f1', { kind: FREE_PUBLIC })

      expect(prisma.facility.update.mock.calls[0]![0].data.kind).toBe(FREE_PUBLIC)
      expect(res.kind).toBe(FREE_PUBLIC)
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'facility.updated',
            payload: { kindFrom: BUSINESS, kindTo: FREE_PUBLIC },
          }),
        }),
      )
    })

    // Leaving BUSINESS makes the facility unquotable, so anything already sold there
    // would be stranded. No force escape hatch on this path by design.
    it('refuses to leave BUSINESS while bookings are still to be honoured, naming the count', async () => {
      setScope({ kind: 'platform' })
      prisma.facility.findFirst.mockResolvedValue({ id: 'f1', kind: BUSINESS })
      prisma.booking.count.mockResolvedValue(4)

      const error = await service
        .update(platformUser, 'f1', { kind: FREE_PUBLIC })
        .catch((e: Error) => e)

      expect(error).toBeInstanceOf(FacilityKindChangeBlockedError)
      expect((error as Error).message).toContain('4 booking(s)')
      expect((error as Error).message).toContain('FREE_PUBLIC')
      expect(prisma.facility.update).not.toHaveBeenCalled()
      expect(prisma.booking.count.mock.calls[0]![0].where.status).toEqual({
        in: ['CONFIRMED', 'CHECKED_IN'],
      })
    })

    // Dead pricing state otherwise: it would silently come back the moment an admin
    // flipped the facility to BUSINESS again.
    it('clears every tariff assignment in the same transaction as the kind change', async () => {
      setScope({ kind: 'platform' })
      prisma.facility.findFirst.mockResolvedValue({ id: 'f1', kind: BUSINESS })
      prisma.facility.update.mockResolvedValue(makeRow({ kind: FREE_PUBLIC }))

      await service.update(platformUser, 'f1', { kind: FREE_PUBLIC })

      expect(tx.facilityTariffAssignment.deleteMany).toHaveBeenCalledWith({
        where: { facilityId: 'f1' },
      })
    })

    it('entering BUSINESS neither checks bookings nor clears assignments', async () => {
      setScope({ kind: 'platform' })
      prisma.facility.findFirst.mockResolvedValue({ id: 'f1', kind: FREE_PUBLIC })
      prisma.facility.update.mockResolvedValue(makeRow({ kind: BUSINESS }))

      await service.update(platformUser, 'f1', { kind: BUSINESS })

      expect(prisma.booking.count).not.toHaveBeenCalled()
      expect(tx.facilityTariffAssignment.deleteMany).not.toHaveBeenCalled()
      expect(prisma.facility.update.mock.calls[0]![0].data.kind).toBe(BUSINESS)
    })

    it('re-setting BUSINESS on a BUSINESS facility is not a departure', async () => {
      setScope({ kind: 'platform' })
      prisma.facility.findFirst.mockResolvedValue({ id: 'f1', kind: BUSINESS })
      prisma.facility.update.mockResolvedValue(makeRow({ kind: BUSINESS }))

      await service.update(platformUser, 'f1', { kind: BUSINESS })

      expect(prisma.booking.count).not.toHaveBeenCalled()
      expect(tx.facilityTariffAssignment.deleteMany).not.toHaveBeenCalled()
    })

    it('an update that does not mention kind carries no kind payload', async () => {
      setScope({ kind: 'platform' })
      prisma.facility.findFirst.mockResolvedValue({ id: 'f1', kind: BUSINESS })
      prisma.facility.update.mockResolvedValue(makeRow())

      await service.update(platformUser, 'f1', { name: 'Renamed' })

      expect(prisma.auditLog.create.mock.calls[0]![0].data.payload).toBeUndefined()
      expect(tx.facilityTariffAssignment.deleteMany).not.toHaveBeenCalled()
    })
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
      ...managed(['op1'], operatorUser.id),
    })
  })

  it('an operator caller only reaches facilities assigned to them, not everything the operator owns', async () => {
    setScope({ kind: 'operator', operatorIds: ['op1'] })
    prisma.facility.findMany.mockResolvedValue([])

    await service.adminList(operatorUser, { skip: 0, take: 20 })

    expect(prisma.facility.findMany.mock.calls[0]![0].where).toEqual(
      managed(['op1'], operatorUser.id),
    )
  })

  it('a platform caller is exempt from the manager narrowing entirely', async () => {
    setScope({ kind: 'platform' })
    prisma.facility.findFirst.mockResolvedValue(makeRow())

    await service.adminGetById(platformUser, 'f1')

    const where = prisma.facility.findFirst.mock.calls[0]![0].where
    expect(where.managers).toBeUndefined()
    expect(where.operatorId).toBeUndefined()
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
      expect(sql.text).toContain('"operatorId" IN ($6,$7)')
      expect(sql.values.slice(5)).toEqual(['op1', 'op2', operatorUser.id])

      const where = prisma.facility.findMany.mock.calls[0]![0].where
      expect(where.AND).toContainEqual({ operatorId: { in: ['op1', 'op2'] } })
      expect(JSON.stringify(where)).not.toContain('op3')
    })

    // The count and the cluster buckets are raw SQL, which no Prisma predicate reaches. If
    // only the points path carried the manager term the map total would contradict the list.
    it('narrows the raw SQL by manager too, with the user id bound not interpolated', async () => {
      setScope({ kind: 'operator', operatorIds: ['op1'] })
      prisma.$queryRaw.mockResolvedValue([{ count: 1 }])

      await service.adminMap(operatorUser, { bounds })

      const sql = sqlOf(prisma.$queryRaw.mock.calls[0]!)
      expect(sql.text).toContain(
        'EXISTS (SELECT 1 FROM "FacilityManager" fm WHERE fm."facilityId" = "Facility"."id" AND fm."userId" = $7)',
      )
      expect(sql.text).not.toContain(operatorUser.id)
      expect(sql.values).toEqual([23, 37, 24, 38, 'ACTIVE', 'op1', operatorUser.id])

      const where = prisma.facility.findMany.mock.calls[0]![0].where
      expect(where.AND).toContainEqual({ managers: { some: { userId: operatorUser.id } } })
    })

    it('leaves a platform caller unnarrowed in the raw SQL', async () => {
      setScope({ kind: 'platform' })

      await service.adminMap(platformUser, { bounds })

      expect(sqlOf(prisma.$queryRaw.mock.calls[0]!).text).not.toContain('"FacilityManager"')
    })

    it('ignores a requested operatorId for an operator caller', async () => {
      setScope({ kind: 'operator', operatorIds: ['op1'] })

      await service.adminMap(operatorUser, { bounds, operatorId: 'op9' })

      expect(sqlOf(prisma.$queryRaw.mock.calls[0]!).values).toEqual([
        23,
        37,
        24,
        38,
        'ACTIVE',
        'op1',
        operatorUser.id,
      ])
    })

    it('binds `q` as a parameter instead of inlining it into the SQL', async () => {
      setScope({ kind: 'platform' })
      const q = `x'); DROP TABLE "Facility"; --`

      await service.adminMap(platformUser, { bounds, q })

      const sql = sqlOf(prisma.$queryRaw.mock.calls[0]!)
      expect(sql.text).toContain('("name" ILIKE $6 OR "address" ILIKE $7)')
      expect(sql.text).not.toContain('DROP TABLE')
      expect(sql.values).toEqual([23, 37, 24, 38, 'ACTIVE', `%${q}%`, `%${q}%`])
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
      expect(sql.text).toContain('"lifecycleStatus" = $5::"LifecycleStatus"')
      expect(sql.text).toContain('"isActive" = $6')
      expect(sql.text).toContain('"isVerified" = $7')
      expect(sql.text).toContain('"kind" = $8::"FacilityKind"')
      expect(sql.text).toContain('"operatorId" IN ($9)')
      expect(sql.text).not.toContain('BUSINESS')
      expect(sql.values).toEqual([23, 37, 24, 38, 'ACTIVE', true, false, 'BUSINESS', 'op9'])
    })

    it('matches bounds on the indexed geog column with longitude-first envelope args', async () => {
      setScope({ kind: 'platform' })

      await service.adminMap(platformUser, { bounds })

      const sql = sqlOf(prisma.$queryRaw.mock.calls[0]!)
      expect(sql.text).toContain(
        'ST_Intersects("geog", ST_MakeEnvelope($1, $2, $3, $4, 4326)::geography)',
      )
      expect(sql.values).toEqual([bounds.west, bounds.south, bounds.east, bounds.north, 'ACTIVE'])
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
          { lifecycleStatus: 'ACTIVE' },
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
          { managers: { some: { userId: operatorUser.id } } },
        ],
      })
      expect(sqlOf(prisma.$queryRaw.mock.calls[0]!).values).toEqual([
        23,
        37,
        24,
        38,
        'ACTIVE',
        '%kolonaki%',
        '%kolonaki%',
        true,
        false,
        'BUSINESS',
        'op1',
        operatorUser.id,
      ])
    })
  })

  describe('delete archives instead of flipping a flag', () => {
    beforeEach(() => {
      setScope({ kind: 'operator', operatorIds: ['op1'] })
      prisma.facility.findFirst.mockResolvedValue({ id: 'f1' })
      prisma.facility.update.mockResolvedValue(makeRow())
    })

    it('delegates the state change to LifecycleService with the acting user as actor', async () => {
      await service.softDelete(operatorUser, 'f1')

      expect(lifecycle.archiveFacility).toHaveBeenCalledWith(
        { id: operatorUser.id, role: operatorUser.role },
        'f1',
        'Deleted by operator',
      )
    })

    // The whole point of the change: a bare isActive=false left the row fully visible to
    // the operator that "deleted" it, and a second audit action would double-count the event.
    it('writes no isActive flag and no facility.deactivated audit row of its own', async () => {
      await service.softDelete(operatorUser, 'f1')

      expect(prisma.facility.update).not.toHaveBeenCalled()
      expect(prisma.auditLog.create).not.toHaveBeenCalled()
    })

    it('refuses a facility outside the caller operator scope before archiving anything', async () => {
      prisma.facility.findFirst.mockResolvedValue(null)

      await expect(service.softDelete(operatorUser, 'f-other')).rejects.toBeInstanceOf(
        FacilityNotFoundError,
      )
      expect(prisma.facility.findFirst.mock.calls[0]![0].where).toEqual({
        id: 'f-other',
        ...managed(['op1'], operatorUser.id),
      })
      expect(lifecycle.archiveFacility).not.toHaveBeenCalled()
    })

    // A lifecycle refusal (a booking taken mid-delete, a concurrent archive) is the
    // caller's answer, not something to swallow into a success.
    it('propagates a refusal from the lifecycle transition', async () => {
      lifecycle.archiveFacility.mockRejectedValue(new FacilityHasActiveBookingsError('f1', 1))

      await expect(service.softDelete(operatorUser, 'f1')).rejects.toBeInstanceOf(
        FacilityHasActiveBookingsError,
      )
    })
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
      expect(lifecycle.archiveFacility).not.toHaveBeenCalled()
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

    // The refund count has nowhere else to go: the delete emits one audit row, the
    // lifecycle's own, so the reason is what carries it into the admin trash listing.
    it('force cancels and refunds each blocking booking, then archives naming the refunds', async () => {
      unhonoured('b1', 'b2')

      await service.softDelete(operatorUser, 'f1', true)

      expect(bookings.cancelBooking.mock.calls.map((c) => c[0])).toEqual(['b1', 'b2'])
      expect(bookings.cancelBooking).toHaveBeenCalledWith('b1', operatorUser)
      expect(lifecycle.archiveFacility).toHaveBeenCalledWith(
        { id: operatorUser.id, role: operatorUser.role },
        'f1',
        'Deleted by operator (forced: 2 booking(s) cancelled and refunded)',
      )
    })

    // Refunds first, archive after — otherwise LifecycleService's own in-transaction
    // re-count would refuse the very bookings this call is about to cancel.
    it('archives only after every refund has gone through', async () => {
      unhonoured('b1')

      await service.softDelete(operatorUser, 'f1', true)

      expect(bookings.cancelBooking.mock.invocationCallOrder[0]!).toBeLessThan(
        lifecycle.archiveFacility.mock.invocationCallOrder[0]!,
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
      expect(lifecycle.archiveFacility).not.toHaveBeenCalled()
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

    // The bulk delete must not diverge from the single-resource one: both archive.
    it('bulk delete archives every scoped facility that owes nothing, flipping no flag', async () => {
      prisma.facility.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }])

      const res = await service.bulkUpdate(operatorUser, {
        ids: ['a', 'b'],
        action: 'delete',
        force: false,
      })

      expect(res).toEqual({ affected: 2 })
      expect(lifecycle.archiveFacility.mock.calls.map((c) => c[1])).toEqual(['a', 'b'])
      expect(lifecycle.archiveFacility).toHaveBeenCalledWith(
        { id: operatorUser.id, role: operatorUser.role },
        'a',
        'Deleted by operator',
      )
      expect(prisma.facility.updateMany).not.toHaveBeenCalled()
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'facility.bulk.delete', entityId: '2 of 2' }),
        }),
      )
    })

    // 'disable' is an unpublish, not a delete, so it keeps the set-based flag flip.
    it('bulk disable still deactivates in one updateMany and archives nothing', async () => {
      prisma.facility.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }])
      prisma.facility.updateMany.mockResolvedValue({ count: 2 })

      const res = await service.bulkUpdate(operatorUser, {
        ids: ['a', 'b'],
        action: 'disable',
        force: false,
      })

      expect(res).toEqual({ affected: 2 })
      expect(prisma.facility.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['a', 'b'] }, ...managed(['op1'], operatorUser.id) },
        data: { isActive: false },
      })
      expect(lifecycle.archiveFacility).not.toHaveBeenCalled()
    })

    it('reports an archive that lost a race as skipped and keeps the rest of the batch', async () => {
      prisma.facility.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }])
      lifecycle.archiveFacility
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new FacilityHasActiveBookingsError('b', 1))

      const res = await service.bulkUpdate(operatorUser, {
        ids: ['a', 'b'],
        action: 'delete',
        force: false,
      })

      expect(res).toEqual({
        affected: 1,
        skipped: [{ facilityId: 'b', reason: 'archive_failed', unhonoured: 0, cancelled: 0 }],
      })
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'facility.bulk.delete', entityId: '1 of 2' }),
        }),
      )
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
        where: { id: { in: ['a'] }, ...managed(['op1'], operatorUser.id) },
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
      expect(lifecycle.archiveFacility.mock.calls.map((c) => c[1])).toEqual(['a'])
      expect(lifecycle.archiveFacility).toHaveBeenCalledWith(
        { id: operatorUser.id, role: operatorUser.role },
        'a',
        'Deleted by operator (forced: 1 booking(s) cancelled and refunded)',
      )
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
      where: { id: { in: ['mine', 'foreign'] }, ...managed(['op1'], operatorUser.id) },
      data: { isActive: true },
    })
  })

  it('operator can bulk publish own facilities (unlike deploy, this does not require platform verification)', async () => {
    setScope({ kind: 'operator', operatorIds: ['op1'] })
    prisma.facility.updateMany.mockResolvedValue({ count: 2 })

    const res = await service.bulkUpdate(operatorUser, { ids: ['a', 'b'], action: 'publish' })

    expect(res).toEqual({ affected: 2 })
    expect(prisma.facility.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['a', 'b'] }, ...managed(['op1'], operatorUser.id) },
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
      where: { id: { in: ['a'] }, ...managed(['op1'], operatorUser.id) },
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
        ...managed(['op1'], operatorUser.id),
      })
      // The plan side narrows on TariffPlanManager, so a caller cannot attach a plan they
      // do not manage to a facility they do.
      expect(prisma.tariffPlan.findFirst.mock.calls[0]![0].where).toEqual({
        id: 'plan1',
        ...managed(['op1'], operatorUser.id),
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
        ...managed(['op1'], operatorUser.id),
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
        ...managed(['op1'], operatorUser.id),
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

  it('accepts a valid FacilityKind on update and rejects anything else', () => {
    expect(updateFacilitySchema.safeParse({ kind: 'FREE_PUBLIC' }).success).toBe(true)
    expect(updateFacilitySchema.safeParse({ kind: 'business' }).success).toBe(false)
    expect(updateFacilitySchema.safeParse({ kind: 'NOT_A_KIND' }).success).toBe(false)
  })

  // Create stays BUSINESS: a kind in the body must be dropped, never honoured.
  it('strips kind from a create body', () => {
    const res = createFacilitySchema.safeParse({ ...validCreate, kind: 'FREE_PUBLIC' })
    expect(res.success).toBe(true)
    if (res.success) expect('kind' in res.data).toBe(false)
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
