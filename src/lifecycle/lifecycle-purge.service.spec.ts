import { Logger } from '@nestjs/common'
import { LifecycleStatus, Prisma } from '@prisma/client'
import type { FirebaseAuthProvider } from '@spark/auth'
import type { PrismaService } from '../prisma/prisma.service'
import { LifecyclePurgeService } from './lifecycle-purge.service'

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
})

afterAll(() => {
  jest.restoreAllMocks()
})

type MockPrisma = {
  facility: { findMany: jest.Mock; count: jest.Mock; delete: jest.Mock }
  tariffPlan: { findMany: jest.Mock; delete: jest.Mock }
  parkingOperator: { findMany: jest.Mock; delete: jest.Mock }
  user: { findMany: jest.Mock; findFirst: jest.Mock; update: jest.Mock }
  booking: { count: jest.Mock }
  facilityOwnershipPeriod: { count: jest.Mock }
  promotionPlan: { count: jest.Mock }
  vehicle: { deleteMany: jest.Mock }
  passwordResetToken: { deleteMany: jest.Mock }
  facilityManager: { deleteMany: jest.Mock }
  tariffPlanManager: { deleteMany: jest.Mock }
  operatorMembership: { deleteMany: jest.Mock }
  auditLog: { create: jest.Mock }
  $transaction: jest.Mock
}

function makePrisma(): MockPrisma {
  const prisma: MockPrisma = {
    facility: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      delete: jest.fn().mockResolvedValue({}),
    },
    tariffPlan: {
      findMany: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue({}),
    },
    parkingOperator: {
      findMany: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue({}),
    },
    user: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
    },
    booking: { count: jest.fn().mockResolvedValue(0) },
    facilityOwnershipPeriod: { count: jest.fn().mockResolvedValue(0) },
    promotionPlan: { count: jest.fn().mockResolvedValue(0) },
    vehicle: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    passwordResetToken: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    facilityManager: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    tariffPlanManager: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    operatorMembership: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(),
  }
  prisma.$transaction.mockImplementation(async (fn: (tx: MockPrisma) => Promise<unknown>) =>
    fn(prisma),
  )
  return prisma
}

function makeFirebase() {
  return { deleteIdentity: jest.fn().mockResolvedValue(undefined) }
}

function makeService(
  prisma: MockPrisma,
  firebase: ReturnType<typeof makeFirebase> = makeFirebase(),
): LifecyclePurgeService {
  return new LifecyclePurgeService(
    prisma as unknown as PrismaService,
    firebase as unknown as FirebaseAuthProvider,
  )
}

function p2003(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('fk violation', {
    code: 'P2003',
    clientVersion: 'test',
  })
}

const NOW = new Date('2026-08-01T00:00:00Z')

describe('LifecyclePurgeService', () => {
  it('selects only tombstoned-and-due rows, in explicit lifecycle terms', async () => {
    const prisma = makePrisma()
    await makeService(prisma).purgeDue(NOW)

    for (const delegate of [prisma.facility, prisma.tariffPlan, prisma.parkingOperator]) {
      expect(delegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { lifecycleStatus: LifecycleStatus.TOMBSTONED, purgeAfter: { lte: NOW } },
        }),
      )
    }
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { lifecycleStatus: LifecycleStatus.TOMBSTONED, purgeAfter: { lte: NOW } },
      }),
    )
  })

  it('skips a facility pinned by bookings instead of attempting the delete', async () => {
    const prisma = makePrisma()
    prisma.facility.findMany.mockResolvedValue([{ id: 'f1' }])
    prisma.booking.count.mockResolvedValue(3)

    const summary = await makeService(prisma).purgeDue(NOW)

    expect(summary.facilities).toEqual({ purged: 0, blocked: 1 })
    expect(prisma.facility.delete).not.toHaveBeenCalled()
  })

  it('deletes a facility with no financial history and audits it', async () => {
    const prisma = makePrisma()
    prisma.facility.findMany.mockResolvedValue([{ id: 'f1' }])

    const summary = await makeService(prisma).purgeDue(NOW)

    expect(summary.facilities).toEqual({ purged: 1, blocked: 0 })
    expect(prisma.facility.delete).toHaveBeenCalledWith({
      where: { id: 'f1', lifecycleStatus: LifecycleStatus.TOMBSTONED },
    })
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ entityType: 'Facility', entityId: 'f1' }),
      }),
    )
  })

  it('treats a RESTRICT violation the pre-check missed as blocked, not an error', async () => {
    const prisma = makePrisma()
    prisma.facility.findMany.mockResolvedValue([{ id: 'f1' }])
    prisma.facility.delete.mockRejectedValue(p2003())

    const summary = await makeService(prisma).purgeDue(NOW)

    expect(summary.facilities).toEqual({ purged: 0, blocked: 1 })
  })

  it('blocks an operator still referenced by any-lifecycle facilities, periods or promotions', async () => {
    const prisma = makePrisma()
    prisma.parkingOperator.findMany.mockResolvedValue([{ id: 'op1' }])
    prisma.facility.count.mockResolvedValue(1)

    const summary = await makeService(prisma).purgeDue(NOW)

    expect(summary.operators).toEqual({ purged: 0, blocked: 1 })
    expect(prisma.parkingOperator.delete).not.toHaveBeenCalled()
    expect(prisma.facility.count).toHaveBeenCalledWith({
      where: {
        operatorId: 'op1',
        lifecycleStatus: { in: Object.values(LifecycleStatus) },
      },
    })
  })

  it('anonymises a user in place and never deletes the row', async () => {
    const prisma = makePrisma()
    prisma.user.findMany.mockResolvedValue([{ id: 'u1', firebaseUid: null }])

    const summary = await makeService(prisma).purgeDue(NOW)

    expect(summary.users).toEqual({ purged: 1, blocked: 0 })
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u1', lifecycleStatus: LifecycleStatus.TOMBSTONED },
        data: expect.objectContaining({
          email: 'deleted+u1@deleted.invalid',
          displayName: null,
          avatarUrl: null,
          passwordHash: null,
          firebaseUid: null,
          emailVerified: false,
          lifecycleStatus: LifecycleStatus.PURGED,
        }),
      }),
    )
    expect(prisma.vehicle.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } })
    expect(prisma.passwordResetToken.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } })
  })

  // The row survives, so the FK cascade never fires — left behind, the assignments would
  // stay live grants belonging to an account that no longer exists in any meaningful sense.
  it('removes the purged user’s management assignments, which no cascade would reach', async () => {
    const prisma = makePrisma()
    prisma.user.findMany.mockResolvedValue([{ id: 'u1', firebaseUid: null }])

    await makeService(prisma).purgeDue(NOW)

    expect(prisma.facilityManager.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } })
    expect(prisma.tariffPlanManager.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } })
  })

  it('releases the operator membership, which keeps a live grant and a paid seat otherwise', async () => {
    const prisma = makePrisma()
    prisma.user.findMany.mockResolvedValue([{ id: 'u1', firebaseUid: null }])

    await makeService(prisma).purgeDue(NOW)

    expect(prisma.operatorMembership.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } })
  })

  /**
   * The defect this covers: anonymisation frees the address in Postgres, so a later invite
   * to it passes every local check and then dies at the identity provider with
   * email-already-exists. A purged person could never be re-registered.
   */
  it('destroys the identity-provider credential so the address can be used again', async () => {
    const prisma = makePrisma()
    const firebase = makeFirebase()
    prisma.user.findMany.mockResolvedValue([{ id: 'u1', firebaseUid: 'fb-1' }])

    await makeService(prisma, firebase).purgeDue(NOW)

    expect(firebase.deleteIdentity).toHaveBeenCalledWith('fb-1')
  })

  it('leaves the credential alone for a user it refuses to purge', async () => {
    const prisma = makePrisma()
    const firebase = makeFirebase()
    prisma.user.findMany.mockResolvedValue([{ id: 'u1', firebaseUid: 'fb-1' }])
    prisma.booking.count.mockResolvedValue(1)

    await makeService(prisma, firebase).purgeDue(NOW)

    expect(firebase.deleteIdentity).not.toHaveBeenCalled()
  })

  it('asks for nothing when the account never had a remote identity', async () => {
    const prisma = makePrisma()
    const firebase = makeFirebase()
    prisma.user.findMany.mockResolvedValue([{ id: 'u1', firebaseUid: null }])

    await makeService(prisma, firebase).purgeDue(NOW)

    expect(firebase.deleteIdentity).not.toHaveBeenCalled()
  })

  /**
   * The local row is already anonymised by the time this runs. Failing the sweep now would
   * re-report a purge that did happen as one that did not, and the row is out of the queue
   * either way — so the stranded uid is logged as an ops item rather than raised.
   */
  it('still counts the purge when the credential could not be destroyed', async () => {
    const prisma = makePrisma()
    const firebase = makeFirebase()
    firebase.deleteIdentity.mockRejectedValue(new Error('google down'))
    prisma.user.findMany.mockResolvedValue([{ id: 'u1', firebaseUid: 'fb-1' }])

    const summary = await makeService(prisma, firebase).purgeDue(NOW)

    expect(summary.users).toEqual({ purged: 1, blocked: 0 })
  })

  /**
   * The on-demand path an administrator drives from /admin/trash, as opposed to the
   * retention sweep. It is the one that ran when a purged address turned out to be
   * un-re-registerable, so it is covered on its own rather than by proxy.
   */
  it('destroys the credential on an approved on-demand purge too', async () => {
    const prisma = makePrisma()
    const firebase = makeFirebase()
    prisma.user.findFirst.mockResolvedValue({
      lifecycleStatus: LifecycleStatus.TOMBSTONED,
      firebaseUid: 'fb-1',
    })

    await makeService(prisma, firebase).purgeOne(
      { id: 'admin-1', role: 'super_admin' },
      'user',
      'u1',
      { reason: 'gdpr', approvalId: 'ap-1', requestedBy: 'admin-2' },
    )

    expect(firebase.deleteIdentity).toHaveBeenCalledWith('fb-1')
  })

  it('leaves assignments intact for a user it refuses to purge', async () => {
    const prisma = makePrisma()
    prisma.user.findMany.mockResolvedValue([{ id: 'u1', firebaseUid: null }])
    prisma.booking.count.mockResolvedValue(1)

    await makeService(prisma).purgeDue(NOW)

    expect(prisma.facilityManager.deleteMany).not.toHaveBeenCalled()
    expect(prisma.tariffPlanManager.deleteMany).not.toHaveBeenCalled()
  })

  it('skips a user with unsettled bookings', async () => {
    const prisma = makePrisma()
    prisma.user.findMany.mockResolvedValue([{ id: 'u1', firebaseUid: null }])
    prisma.booking.count.mockResolvedValue(1)

    const summary = await makeService(prisma).purgeDue(NOW)

    expect(summary.users).toEqual({ purged: 0, blocked: 1 })
    expect(prisma.user.update).not.toHaveBeenCalled()
  })

  it('is idempotent: a second run over a drained queue does nothing', async () => {
    const prisma = makePrisma()
    prisma.tariffPlan.findMany.mockResolvedValueOnce([{ id: 'p1' }]).mockResolvedValueOnce([])

    const service = makeService(prisma)
    const first = await service.purgeDue(NOW)
    const second = await service.purgeDue(NOW)

    expect(first.tariffPlans).toEqual({ purged: 1, blocked: 0 })
    expect(second.tariffPlans).toEqual({ purged: 0, blocked: 0 })
    expect(prisma.tariffPlan.delete).toHaveBeenCalledTimes(1)
  })

  it('counts a row another worker already removed as done, and isolates unexpected failures', async () => {
    const prisma = makePrisma()
    prisma.tariffPlan.findMany.mockResolvedValue([{ id: 'p1' }, { id: 'p2' }])
    prisma.tariffPlan.delete
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('gone', { code: 'P2025', clientVersion: 'test' }),
      )
      .mockRejectedValueOnce(new Error('connection reset'))

    const summary = await makeService(prisma).purgeDue(NOW)

    expect(summary.tariffPlans).toEqual({ purged: 1, blocked: 1 })
  })
})
