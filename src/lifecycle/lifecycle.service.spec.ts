import { LifecycleStatus, Prisma } from '@prisma/client'
import type { ConfigService } from '@nestjs/config'
import {
  EntitlementLimitExceededError,
  FacilityHasActiveBookingsError,
  LifecycleResourceNotFoundError,
  LifecycleRestoreConflictError,
  LifecycleTransitionError,
  OperatorHasActiveFacilitiesError,
} from '../common/errors/domain.errors'
import type { PrismaService } from '../prisma/prisma.service'
import type { EntitlementService } from '../subscriptions/entitlement.service'
import { LifecycleService } from './lifecycle.service'

const ACTOR = { id: 'admin-1', role: 'platform_admin' }

type Tx = {
  facility: { findFirst: jest.Mock; update: jest.Mock; count: jest.Mock }
  tariffPlan: { findFirst: jest.Mock; update: jest.Mock }
  parkingOperator: { findFirst: jest.Mock; update: jest.Mock }
  user: { findFirst: jest.Mock; update: jest.Mock }
  booking: { count: jest.Mock }
  auditLog: { create: jest.Mock }
  $executeRaw: jest.Mock
}

function makeTx(): Tx {
  return {
    facility: { findFirst: jest.fn(), update: jest.fn(), count: jest.fn().mockResolvedValue(0) },
    tariffPlan: { findFirst: jest.fn(), update: jest.fn() },
    parkingOperator: { findFirst: jest.fn(), update: jest.fn() },
    user: { findFirst: jest.fn(), update: jest.fn() },
    booking: { count: jest.fn().mockResolvedValue(0) },
    auditLog: { create: jest.fn() },
    $executeRaw: jest.fn(),
  }
}

type Entitlements = { assertCanCreateFacility: jest.Mock; assertCanCreateTariffPlan: jest.Mock }

function makeEntitlements(): Entitlements {
  // Quota is EntitlementService's job and has its own suite; here it always permits, so
  // these cases exercise lifecycle transitions rather than re-testing quotas.
  return {
    assertCanCreateFacility: jest.fn().mockResolvedValue(undefined),
    assertCanCreateTariffPlan: jest.fn().mockResolvedValue(undefined),
  }
}

function makeService(tx: Tx, entitlements: Entitlements): LifecycleService {
  const prisma = {
    $transaction: jest.fn(async (fn: (client: Tx) => Promise<unknown>) => fn(tx)),
  }
  const config = { get: jest.fn().mockReturnValue(30) }
  return new LifecycleService(
    prisma as unknown as PrismaService,
    config as unknown as ConfigService,
    entitlements as unknown as EntitlementService,
  )
}

function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('unique violation', {
    code: 'P2002',
    clientVersion: 'test',
  })
}

describe('LifecycleService — facility', () => {
  let tx: Tx
  let entitlements: Entitlements
  let service: LifecycleService

  beforeEach(() => {
    tx = makeTx()
    entitlements = makeEntitlements()
    service = makeService(tx, entitlements)
  })

  it('archives an active facility, forcing unpublish', async () => {
    tx.facility.findFirst.mockResolvedValue({
      id: 'f1',
      operatorId: 'op1',
      lifecycleStatus: LifecycleStatus.ACTIVE,
    })

    await service.archiveFacility(ACTOR, 'f1', 'fraud')

    expect(tx.facility.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'f1', lifecycleStatus: LifecycleStatus.ACTIVE },
        data: expect.objectContaining({
          lifecycleStatus: LifecycleStatus.ARCHIVED,
          lifecycleChangedBy: 'admin-1',
          lifecycleReason: 'fraud',
          isActive: false,
        }),
      }),
    )
    expect(tx.auditLog.create).toHaveBeenCalled()
  })

  it('refuses to archive a facility with unhonoured bookings', async () => {
    tx.facility.findFirst.mockResolvedValue({
      id: 'f1',
      operatorId: 'op1',
      lifecycleStatus: LifecycleStatus.ACTIVE,
    })
    tx.booking.count.mockResolvedValue(2)

    await expect(service.archiveFacility(ACTOR, 'f1')).rejects.toBeInstanceOf(
      FacilityHasActiveBookingsError,
    )
    expect(tx.facility.update).not.toHaveBeenCalled()
  })

  it('refuses transitions that do not start from an allowed state', async () => {
    tx.facility.findFirst.mockResolvedValue({
      id: 'f1',
      operatorId: 'op1',
      lifecycleStatus: LifecycleStatus.TOMBSTONED,
    })

    await expect(service.archiveFacility(ACTOR, 'f1')).rejects.toBeInstanceOf(
      LifecycleTransitionError,
    )
  })

  it('reports a missing row as not found', async () => {
    tx.facility.findFirst.mockResolvedValue(null)

    await expect(service.restoreFacility(ACTOR, 'nope')).rejects.toBeInstanceOf(
      LifecycleResourceNotFoundError,
    )
  })

  it('tombstones with a purge-after instant derived from the retention window', async () => {
    tx.facility.findFirst.mockResolvedValue({
      id: 'f1',
      operatorId: 'op1',
      lifecycleStatus: LifecycleStatus.ARCHIVED,
    })
    const before = Date.now()

    await service.tombstoneFacility(ACTOR, 'f1')

    const data = tx.facility.update.mock.calls[0][0].data as { purgeAfter: Date }
    const expected = 30 * 86_400_000
    expect(data.purgeAfter.getTime() - before).toBeGreaterThanOrEqual(expected - 1000)
    expect(data.purgeAfter.getTime() - before).toBeLessThanOrEqual(expected + 60_000)
  })

  it('refuses restore when the operator is at its facility entitlement', async () => {
    tx.facility.findFirst.mockResolvedValueOnce({
      id: 'f1',
      operatorId: 'op1',
      lifecycleStatus: LifecycleStatus.ARCHIVED,
    })
    entitlements.assertCanCreateFacility.mockRejectedValueOnce(
      new EntitlementLimitExceededError('facilities', 1, 1),
    )

    await expect(service.restoreFacility(ACTOR, 'f1')).rejects.toBeInstanceOf(
      EntitlementLimitExceededError,
    )
    expect(tx.facility.update).not.toHaveBeenCalled()
  })

  it('locks the operator row before checking quota, so a concurrent create cannot slip past', async () => {
    tx.facility.findFirst.mockResolvedValueOnce({
      id: 'f1',
      operatorId: 'op1',
      lifecycleStatus: LifecycleStatus.ARCHIVED,
    })

    await service.restoreFacility(ACTOR, 'f1')

    // The partial unique index that used to backstop this was dropped with the
    // one-facility cap, so ordering here is the whole guarantee.
    const lockOrder = tx.$executeRaw.mock.invocationCallOrder[0]
    const checkOrder = entitlements.assertCanCreateFacility.mock.invocationCallOrder[0]
    expect(lockOrder).toBeDefined()
    expect(checkOrder).toBeDefined()
    expect(lockOrder as number).toBeLessThan(checkOrder as number)
    expect(entitlements.assertCanCreateFacility).toHaveBeenCalledWith('op1', tx)
  })

  it('restores without republishing', async () => {
    tx.facility.findFirst.mockResolvedValueOnce({
      id: 'f1',
      operatorId: 'op1',
      lifecycleStatus: LifecycleStatus.ARCHIVED,
    })

    await service.restoreFacility(ACTOR, 'f1')

    const data = tx.facility.update.mock.calls[0][0].data as Record<string, unknown>
    expect(data['lifecycleStatus']).toBe(LifecycleStatus.ACTIVE)
    expect(data['purgeAfter']).toBeNull()
    expect(data).not.toHaveProperty('isActive')
  })
})

describe('LifecycleService — tariff plan', () => {
  let tx: Tx
  let service: LifecycleService
  let entitlements: Entitlements

  beforeEach(() => {
    tx = makeTx()
    entitlements = makeEntitlements()
    service = makeService(tx, entitlements)
  })

  it('archives preserving isActive and isDefault', async () => {
    tx.tariffPlan.findFirst.mockResolvedValue({
      id: 'p1',
      operatorId: 'op1',
      lifecycleStatus: LifecycleStatus.ACTIVE,
      isActive: true,
      isDefault: true,
    })

    await service.archiveTariffPlan(ACTOR, 'p1')

    const data = tx.tariffPlan.update.mock.calls[0][0].data as Record<string, unknown>
    expect(data['lifecycleStatus']).toBe(LifecycleStatus.ARCHIVED)
    expect(data).not.toHaveProperty('isActive')
    expect(data).not.toHaveProperty('isDefault')
  })

  it('refuses restore of an active default when another plan holds the slot', async () => {
    tx.tariffPlan.findFirst
      .mockResolvedValueOnce({
        id: 'p1',
        operatorId: 'op1',
        lifecycleStatus: LifecycleStatus.ARCHIVED,
        isActive: true,
        isDefault: true,
      })
      .mockResolvedValueOnce({ id: 'p2', name: 'New Default' })

    await expect(service.restoreTariffPlan(ACTOR, 'p1')).rejects.toThrow(
      /p2 "New Default" is now the operator's active default/,
    )
  })

  it('restores a non-default plan without any conflict lookup', async () => {
    tx.tariffPlan.findFirst.mockResolvedValueOnce({
      id: 'p1',
      operatorId: 'op1',
      lifecycleStatus: LifecycleStatus.TOMBSTONED,
      isActive: true,
      isDefault: false,
    })

    await service.restoreTariffPlan(ACTOR, 'p1')

    expect(tx.tariffPlan.findFirst).toHaveBeenCalledTimes(1)
    expect(tx.tariffPlan.update).toHaveBeenCalled()
  })

  // Restoring an active plan returns it to the counted set, so it costs a slot exactly as
  // a create does — the facility twin has always checked this and the plan path had not.
  it('charges the plan quota when restoring an active plan, under the operator lock', async () => {
    tx.tariffPlan.findFirst.mockResolvedValueOnce({
      id: 'p1',
      operatorId: 'op1',
      lifecycleStatus: LifecycleStatus.TOMBSTONED,
      isActive: true,
      isDefault: false,
    })

    await service.restoreTariffPlan(ACTOR, 'p1')

    expect(entitlements.assertCanCreateTariffPlan).toHaveBeenCalledWith('op1', tx)
    const lockOrder = tx.$executeRaw.mock.invocationCallOrder[0]!
    const checkOrder = entitlements.assertCanCreateTariffPlan.mock.invocationCallOrder[0]!
    expect(lockOrder).toBeLessThan(checkOrder)
  })

  it('refuses the restore when the plan quota is already full', async () => {
    tx.tariffPlan.findFirst.mockResolvedValueOnce({
      id: 'p1',
      operatorId: 'op1',
      lifecycleStatus: LifecycleStatus.TOMBSTONED,
      isActive: true,
      isDefault: false,
    })
    entitlements.assertCanCreateTariffPlan.mockRejectedValueOnce(
      new EntitlementLimitExceededError('tariff plans', 3, 3),
    )

    await expect(service.restoreTariffPlan(ACTOR, 'p1')).rejects.toBeInstanceOf(
      EntitlementLimitExceededError,
    )
    expect(tx.tariffPlan.update).not.toHaveBeenCalled()
  })

  it('charges nothing to restore an inactive plan — it rejoins no count', async () => {
    tx.tariffPlan.findFirst.mockResolvedValueOnce({
      id: 'p1',
      operatorId: 'op1',
      lifecycleStatus: LifecycleStatus.ARCHIVED,
      isActive: false,
      isDefault: false,
    })

    await service.restoreTariffPlan(ACTOR, 'p1')

    expect(entitlements.assertCanCreateTariffPlan).not.toHaveBeenCalled()
    expect(tx.tariffPlan.update).toHaveBeenCalled()
  })

  it('translates a concurrent default-slot P2002 on restore', async () => {
    tx.tariffPlan.findFirst
      .mockResolvedValueOnce({
        id: 'p1',
        operatorId: 'op1',
        lifecycleStatus: LifecycleStatus.ARCHIVED,
        isActive: true,
        isDefault: true,
      })
      .mockResolvedValueOnce(null)
    tx.tariffPlan.update.mockRejectedValueOnce(p2002())

    await expect(service.restoreTariffPlan(ACTOR, 'p1')).rejects.toBeInstanceOf(
      LifecycleRestoreConflictError,
    )
  })
})

describe('LifecycleService — operator', () => {
  let tx: Tx
  let service: LifecycleService

  beforeEach(() => {
    tx = makeTx()
    service = makeService(tx, makeEntitlements())
  })

  it('refuses to archive an operator that still has lifecycle-active facilities', async () => {
    tx.parkingOperator.findFirst.mockResolvedValue({
      id: 'op1',
      lifecycleStatus: LifecycleStatus.ACTIVE,
    })
    tx.facility.count.mockResolvedValue(1)

    await expect(service.archiveOperator(ACTOR, 'op1')).rejects.toBeInstanceOf(
      OperatorHasActiveFacilitiesError,
    )
  })

  it('archives and restores an operator with no active facilities', async () => {
    tx.parkingOperator.findFirst.mockResolvedValue({
      id: 'op1',
      lifecycleStatus: LifecycleStatus.ACTIVE,
    })

    await service.archiveOperator(ACTOR, 'op1', 'contract ended')

    tx.parkingOperator.findFirst.mockResolvedValue({
      id: 'op1',
      lifecycleStatus: LifecycleStatus.ARCHIVED,
    })

    await service.restoreOperator(ACTOR, 'op1')

    const restore = tx.parkingOperator.update.mock.calls[1][0].data as Record<string, unknown>
    expect(restore['lifecycleStatus']).toBe(LifecycleStatus.ACTIVE)
  })
})

describe('LifecycleService — user', () => {
  let tx: Tx
  let service: LifecycleService

  beforeEach(() => {
    tx = makeTx()
    service = makeService(tx, makeEntitlements())
  })

  it('archiving revokes sessions via the watermark', async () => {
    tx.user.findFirst.mockResolvedValue({
      id: 'u1',
      lifecycleStatus: LifecycleStatus.ACTIVE,
      deletedAt: null,
    })

    await service.archiveUser(ACTOR, 'u1')

    const data = tx.user.update.mock.calls[0][0].data as Record<string, unknown>
    expect(data['sessionsValidFrom']).toBeInstanceOf(Date)
    expect(data['lifecycleStatus']).toBe(LifecycleStatus.ARCHIVED)
  })

  it('refuses to restore an anonymised account', async () => {
    tx.user.findFirst.mockResolvedValue({
      id: 'u1',
      lifecycleStatus: LifecycleStatus.TOMBSTONED,
      deletedAt: new Date(),
    })

    await expect(service.restoreUser(ACTOR, 'u1')).rejects.toThrow(/anonymised/)
    expect(tx.user.update).not.toHaveBeenCalled()
  })

  it('restore does not clear the session revocation watermark', async () => {
    tx.user.findFirst.mockResolvedValue({
      id: 'u1',
      lifecycleStatus: LifecycleStatus.ARCHIVED,
      deletedAt: null,
    })

    await service.restoreUser(ACTOR, 'u1')

    const data = tx.user.update.mock.calls[0][0].data as Record<string, unknown>
    expect(data).not.toHaveProperty('sessionsValidFrom')
  })
})
