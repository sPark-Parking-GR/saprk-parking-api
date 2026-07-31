import { ForbiddenException } from '@nestjs/common'
import { BookingStatus } from '@prisma/client'
import { InvalidCredentialsError, InvalidTokenError } from '@spark/auth'
import type { AuthContext, FirebaseAuthProvider } from '@spark/auth'
import type { AuthUser } from '@spark/types'
import type { PrismaService } from '../prisma/prisma.service'
import { AccountDeletionService } from './account-deletion.service'
import { AccountHasUnsettledBookingsError } from './auth.types'

const CONSUMER: AuthUser = {
  id: 'u1',
  email: 'driver@spark.gr',
  role: 'user',
  emailVerified: true,
  displayName: 'Driver',
}

const TOKEN = 'access-token'

describe('AccountDeletionService', () => {
  let tx: {
    user: { update: jest.Mock }
    vehicle: { deleteMany: jest.Mock }
    passwordResetToken: { deleteMany: jest.Mock }
    auditLog: { create: jest.Mock }
  }
  let prisma: {
    user: { findUnique: jest.Mock }
    booking: { count: jest.Mock }
    $transaction: jest.Mock
  }
  let auth: { signIn: jest.Mock; signOut: jest.Mock }
  let firebase: { deleteIdentity: jest.Mock }
  let service: AccountDeletionService

  const account = (overrides: Record<string, unknown> = {}) =>
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      email: 'driver@spark.gr',
      firebaseUid: null,
      deletedAt: null,
      ...overrides,
    })

  const userUpdate = () =>
    tx.user.update.mock.calls[0]![0] as {
      where: { id: string }
      data: { deletedAt: Date; sessionsValidFrom: Date }
    }

  beforeEach(() => {
    tx = {
      user: { update: jest.fn() },
      vehicle: { deleteMany: jest.fn() },
      passwordResetToken: { deleteMany: jest.fn() },
      auditLog: { create: jest.fn() },
    }
    prisma = {
      user: { findUnique: jest.fn() },
      booking: { count: jest.fn().mockResolvedValue(0) },
      $transaction: jest.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
    }
    auth = {
      signIn: jest.fn().mockResolvedValue({}),
      signOut: jest.fn().mockResolvedValue(undefined),
    }
    firebase = { deleteIdentity: jest.fn().mockResolvedValue(undefined) }
    service = new AccountDeletionService(
      prisma as unknown as PrismaService,
      auth as unknown as AuthContext,
      firebase as unknown as FirebaseAuthProvider,
    )
    account()
  })

  it('re-checks the password before touching anything', async () => {
    await service.deleteOwnAccount(CONSUMER, 'correct-horse', TOKEN)

    expect(auth.signIn).toHaveBeenCalledWith({
      email: 'driver@spark.gr',
      password: 'correct-horse',
    })
  })

  it('deletes nothing when the password is wrong', async () => {
    auth.signIn.mockRejectedValue(new InvalidCredentialsError())

    await expect(service.deleteOwnAccount(CONSUMER, 'guess', TOKEN)).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    )
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  // Both layers gate the role: an operator identity owns memberships and facilities that a
  // self-service tombstone would strand.
  it('refuses a non-consumer account even past the controller guard', async () => {
    await expect(
      service.deleteOwnAccount({ ...CONSUMER, role: 'operator_admin' }, 'pw', TOKEN),
    ).rejects.toBeInstanceOf(ForbiddenException)
    expect(auth.signIn).not.toHaveBeenCalled()
  })

  it('refuses an account that is already a tombstone', async () => {
    account({ deletedAt: new Date() })

    await expect(service.deleteOwnAccount(CONSUMER, 'pw', TOKEN)).rejects.toBeInstanceOf(
      InvalidTokenError,
    )
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('refuses while a booking is still unsettled, rather than stranding it', async () => {
    prisma.booking.count.mockResolvedValue(2)

    await expect(service.deleteOwnAccount(CONSUMER, 'pw', TOKEN)).rejects.toBeInstanceOf(
      AccountHasUnsettledBookingsError,
    )
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('counts a live hold, a stay in progress and a pending refund as unsettled', async () => {
    await service.deleteOwnAccount(CONSUMER, 'pw', TOKEN)

    const where = prisma.booking.count.mock.calls[0]![0].where as {
      userId: string
      OR: { status: unknown }[]
    }
    expect(where.userId).toBe('u1')
    expect(where.OR).toEqual([
      {
        status: { in: [BookingStatus.CONFIRMED, BookingStatus.CHECKED_IN] },
        endsAt: { gt: expect.any(Date) },
      },
      { status: BookingStatus.PENDING_PAYMENT, expiresAt: { gt: expect.any(Date) } },
      { status: BookingStatus.REFUND_PENDING },
    ])
  })

  it('anonymises the row instead of deleting it, and frees the address', async () => {
    await service.deleteOwnAccount(CONSUMER, 'pw', TOKEN)

    expect(userUpdate()).toEqual({
      where: { id: 'u1' },
      data: {
        email: 'deleted+u1@deleted.invalid',
        displayName: null,
        avatarUrl: null,
        passwordHash: null,
        firebaseUid: null,
        emailVerified: false,
        deletedAt: expect.any(Date),
        sessionsValidFrom: expect.any(Date),
      },
    })
  })

  it('revokes every existing session as part of the same write', async () => {
    await service.deleteOwnAccount(CONSUMER, 'pw', TOKEN)

    const { data } = userUpdate()
    expect(data.sessionsValidFrom).toEqual(data.deletedAt)
    expect(auth.signOut).toHaveBeenCalledWith(TOKEN)
  })

  it('clears the plates and the outstanding reset grants', async () => {
    await service.deleteOwnAccount(CONSUMER, 'pw', TOKEN)

    expect(tx.vehicle.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } })
    expect(tx.passwordResetToken.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } })
  })

  it('audits the deletion', async () => {
    await service.deleteOwnAccount(CONSUMER, 'pw', TOKEN)

    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: {
        actorId: 'u1',
        actorRole: 'user',
        action: 'account.deleted',
        entityType: 'User',
        entityId: 'u1',
        payload: { selfService: true },
      },
    })
  })

  it('removes the Firebase identity for a Firebase-backed account', async () => {
    account({ firebaseUid: 'fb-1' })

    await service.deleteOwnAccount(CONSUMER, 'pw', TOKEN)

    expect(firebase.deleteIdentity).toHaveBeenCalledWith('fb-1')
  })

  it('leaves Firebase alone for an authjs account', async () => {
    await service.deleteOwnAccount(CONSUMER, 'pw', TOKEN)

    expect(firebase.deleteIdentity).not.toHaveBeenCalled()
  })

  // The local account is already gone at this point; reporting a failure would describe a
  // deletion that did happen as one that did not.
  it('still succeeds when the Firebase identity cannot be removed', async () => {
    account({ firebaseUid: 'fb-1' })
    firebase.deleteIdentity.mockRejectedValue(new Error('firebase down'))

    await expect(service.deleteOwnAccount(CONSUMER, 'pw', TOKEN)).resolves.toBeUndefined()
  })
})
