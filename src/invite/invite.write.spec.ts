import { createHash } from 'crypto'
import { ForbiddenException } from '@nestjs/common'
import type { ConfigService } from '@nestjs/config'
import type { IAuthProvider } from '@spark/auth'
import type { AuthResult, AuthUser } from '@spark/types'
import { InviteStatus } from '@prisma/client'
import type { PrismaService } from '../prisma/prisma.service'
import type { NotificationsService } from '../notifications/notifications.service'
import { InviteService } from './invite.service'
import {
  InviteAlreadyAcceptedError,
  InviteExpiredError,
  InviteNotFoundError,
  InviteNotRevocableError,
} from './invite.types'

const platformUser: AuthUser = {
  id: 'admin-1',
  email: 'super@spark.gr',
  role: 'platform_admin',
  emailVerified: true,
}

const operatorUser: AuthUser = {
  id: 'op-1',
  email: 'op@spark.gr',
  role: 'operator_admin',
  emailVerified: true,
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

const futureDate = () => new Date(Date.now() + 60_000)
const pastDate = () => new Date(Date.now() - 60_000)

function authResult(userId: string): AuthResult {
  return {
    session: {
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: Date.now() + 60_000,
      user: { id: userId, email: 'new@spark.gr', role: 'operator_admin', emailVerified: false },
    },
  }
}

describe('InviteService', () => {
  let prisma: {
    parkingOperator: { create: jest.Mock; update: jest.Mock; delete: jest.Mock }
    operatorInvite: {
      create: jest.Mock
      findUnique: jest.Mock
      findMany: jest.Mock
      update: jest.Mock
      updateMany: jest.Mock
    }
    operatorMembership: { create: jest.Mock }
    user: { update: jest.Mock }
    $transaction: jest.Mock
  }
  let tx: {
    parkingOperator: { create: jest.Mock; update: jest.Mock }
    operatorInvite: { create: jest.Mock; update: jest.Mock }
    operatorMembership: { create: jest.Mock }
    user: { update: jest.Mock }
  }
  let notifications: { sendOperatorInvite: jest.Mock }
  let config: { getOrThrow: jest.Mock }
  let firebase: { signUp: jest.Mock; deleteUser: jest.Mock }
  let service: InviteService

  beforeEach(() => {
    tx = {
      parkingOperator: { create: jest.fn(), update: jest.fn() },
      operatorInvite: { create: jest.fn(), update: jest.fn() },
      operatorMembership: { create: jest.fn() },
      user: { update: jest.fn() },
    }
    prisma = {
      parkingOperator: {
        create: tx.parkingOperator.create,
        update: tx.parkingOperator.update,
        delete: jest.fn(),
      },
      operatorInvite: {
        create: tx.operatorInvite.create,
        findUnique: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      operatorMembership: { create: tx.operatorMembership.create },
      user: { update: tx.user.update },
      $transaction: jest.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
    }
    notifications = { sendOperatorInvite: jest.fn().mockResolvedValue(undefined) }
    config = { getOrThrow: jest.fn().mockReturnValue('http://localhost:3000') }
    firebase = { signUp: jest.fn(), deleteUser: jest.fn().mockResolvedValue(undefined) }

    service = new InviteService(
      prisma as unknown as PrismaService,
      notifications as unknown as NotificationsService,
      config as unknown as ConfigService,
      firebase as unknown as IAuthProvider,
    )
  })

  describe('create', () => {
    it('creates a PENDING operator + invite, emails the accept link, never returns the raw token', async () => {
      tx.parkingOperator.create.mockResolvedValue({ id: 'op-new' })
      tx.operatorInvite.create.mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
        id: 'inv-1',
        email: data.email,
        businessName: data.businessName,
        status: InviteStatus.PENDING,
        expiresAt: data.expiresAt,
        createdAt: new Date(),
      }))

      const summary = await service.create(platformUser, {
        email: 'Owner@Biz.com',
        businessName: 'Biz Parking',
      })

      expect(tx.parkingOperator.create.mock.calls[0]![0].data).toMatchObject({
        name: 'Biz Parking',
        status: 'PENDING',
      })

      const inviteData = tx.operatorInvite.create.mock.calls[0]![0].data
      expect(inviteData.email).toBe('owner@biz.com')
      expect(inviteData.operatorId).toBe('op-new')
      expect(inviteData.invitedById).toBe('admin-1')

      const acceptUrl: string = notifications.sendOperatorInvite.mock.calls[0]![0].acceptUrl
      const rawToken = acceptUrl.split('/invite/accept/')[1]!
      expect(rawToken).toMatch(/^[a-f0-9]{64}$/)
      // Only the hash is persisted; the raw token exists solely in the emailed link.
      expect(inviteData.tokenHash).toBe(sha256(rawToken))

      expect(summary).not.toHaveProperty('tokenHash')
      expect(summary).not.toHaveProperty('token')
      expect(summary).toMatchObject({ id: 'inv-1', email: 'owner@biz.com', businessName: 'Biz Parking' })
    })

    it('rejects a non-platform-admin actor (service-layer re-check)', async () => {
      await expect(
        service.create(operatorUser, { email: 'a@b.com', businessName: 'X' }),
      ).rejects.toBeInstanceOf(ForbiddenException)
      expect(prisma.$transaction).not.toHaveBeenCalled()
    })
  })

  describe('list', () => {
    it('returns invites ordered newest-first without leaking the token hash', async () => {
      prisma.operatorInvite.findMany.mockResolvedValue([
        {
          id: 'inv-2',
          email: 'b@biz.com',
          businessName: 'Biz B',
          status: InviteStatus.PENDING,
          expiresAt: futureDate(),
          createdAt: new Date('2026-01-02'),
          acceptedAt: null,
          tokenHash: 'secret-hash',
        },
      ])

      const result = await service.list(platformUser)

      expect(prisma.operatorInvite.findMany).toHaveBeenCalledWith({
        orderBy: { createdAt: 'desc' },
      })
      expect(result).toEqual([
        {
          id: 'inv-2',
          email: 'b@biz.com',
          businessName: 'Biz B',
          status: InviteStatus.PENDING,
          expiresAt: expect.any(Date),
          createdAt: new Date('2026-01-02'),
          acceptedAt: null,
        },
      ])
    })

    it('rejects a non-platform-admin actor (service-layer re-check)', async () => {
      await expect(service.list(operatorUser)).rejects.toBeInstanceOf(ForbiddenException)
      expect(prisma.operatorInvite.findMany).not.toHaveBeenCalled()
    })
  })

  describe('revoke', () => {
    it('flips the invite to REVOKED and deletes its unclaimed PENDING operator', async () => {
      prisma.operatorInvite.updateMany.mockResolvedValue({ count: 1 })
      prisma.operatorInvite.findUnique.mockResolvedValue({
        operatorId: 'op-new',
        operator: { status: 'PENDING' },
      })

      await expect(service.revoke(platformUser, 'inv-1')).resolves.toBeUndefined()

      expect(prisma.operatorInvite.updateMany).toHaveBeenCalledWith({
        where: { id: 'inv-1', status: InviteStatus.PENDING },
        data: { status: InviteStatus.REVOKED },
      })
      expect(prisma.parkingOperator.delete).toHaveBeenCalledWith({ where: { id: 'op-new' } })
    })

    it('leaves an already-claimed operator alone', async () => {
      prisma.operatorInvite.updateMany.mockResolvedValue({ count: 1 })
      prisma.operatorInvite.findUnique.mockResolvedValue({
        operatorId: 'op-new',
        operator: { status: 'VERIFIED' },
      })

      await service.revoke(platformUser, 'inv-1')

      expect(prisma.parkingOperator.delete).not.toHaveBeenCalled()
    })

    it('throws InviteNotFoundError when no invite matches the id', async () => {
      prisma.operatorInvite.updateMany.mockResolvedValue({ count: 0 })
      prisma.operatorInvite.findUnique.mockResolvedValue(null)

      await expect(service.revoke(platformUser, 'nope')).rejects.toBeInstanceOf(InviteNotFoundError)
      expect(prisma.parkingOperator.delete).not.toHaveBeenCalled()
    })

    it('loses the accept-vs-revoke race cleanly with InviteAlreadyAcceptedError', async () => {
      prisma.operatorInvite.updateMany.mockResolvedValue({ count: 0 })
      prisma.operatorInvite.findUnique.mockResolvedValue({ status: InviteStatus.ACCEPTED })

      await expect(service.revoke(platformUser, 'inv-1')).rejects.toBeInstanceOf(
        InviteAlreadyAcceptedError,
      )
      expect(prisma.parkingOperator.delete).not.toHaveBeenCalled()
    })

    it('throws InviteNotRevocableError for a non-pending, non-accepted invite', async () => {
      prisma.operatorInvite.updateMany.mockResolvedValue({ count: 0 })
      prisma.operatorInvite.findUnique.mockResolvedValue({ status: InviteStatus.EXPIRED })

      await expect(service.revoke(platformUser, 'inv-1')).rejects.toBeInstanceOf(
        InviteNotRevocableError,
      )
    })

    it('rejects a non-platform-admin actor (service-layer re-check)', async () => {
      await expect(service.revoke(operatorUser, 'inv-1')).rejects.toBeInstanceOf(ForbiddenException)
      expect(prisma.operatorInvite.updateMany).not.toHaveBeenCalled()
    })
  })

  describe('validate', () => {
    it('throws InviteNotFoundError when no invite matches the token hash', async () => {
      prisma.operatorInvite.findUnique.mockResolvedValue(null)
      await expect(service.validate('nope')).rejects.toBeInstanceOf(InviteNotFoundError)
    })

    it('reports not-expired for a PENDING invite in the future', async () => {
      prisma.operatorInvite.findUnique.mockResolvedValue({
        businessName: 'Biz',
        email: 'a@b.com',
        status: InviteStatus.PENDING,
        expiresAt: futureDate(),
      })
      await expect(service.validate('tok')).resolves.toEqual({
        businessName: 'Biz',
        email: 'a@b.com',
        expired: false,
      })
    })

    it('reports expired for an already-accepted invite', async () => {
      prisma.operatorInvite.findUnique.mockResolvedValue({
        businessName: 'Biz',
        email: 'a@b.com',
        status: InviteStatus.ACCEPTED,
        expiresAt: futureDate(),
      })
      await expect(service.validate('tok')).resolves.toMatchObject({ expired: true })
    })
  })

  describe('accept', () => {
    const pendingInvite = () => ({
      id: 'inv-1',
      email: 'new@spark.gr',
      businessName: 'Biz Parking',
      operatorId: 'op-new',
      status: InviteStatus.PENDING,
      expiresAt: futureDate(),
    })

    it('provisions the operator identity and completes the attachment transaction', async () => {
      prisma.operatorInvite.findUnique.mockResolvedValue(pendingInvite())
      const expected = authResult('user-new')
      firebase.signUp.mockResolvedValue(expected)

      const result = await service.accept('tok', 'password123')

      expect(firebase.signUp).toHaveBeenCalledWith({
        email: 'new@spark.gr',
        password: 'password123',
        displayName: 'Biz Parking',
        role: 'operator_admin',
      })
      expect(tx.operatorMembership.create).toHaveBeenCalledWith({
        data: { operatorId: 'op-new', userId: 'user-new', role: 'ADMIN' },
      })
      expect(tx.parkingOperator.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'op-new' }, data: expect.objectContaining({ status: 'VERIFIED' }) }),
      )
      expect(tx.user.update).toHaveBeenCalledWith({ where: { id: 'user-new' }, data: { emailVerified: true } })
      expect(tx.operatorInvite.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'inv-1' }, data: expect.objectContaining({ status: 'ACCEPTED' }) }),
      )
      expect(firebase.deleteUser).not.toHaveBeenCalled()
      expect(result).toBe(expected)
    })

    it('throws InviteNotFoundError for an unknown token', async () => {
      prisma.operatorInvite.findUnique.mockResolvedValue(null)
      await expect(service.accept('tok', 'password123')).rejects.toBeInstanceOf(InviteNotFoundError)
      expect(firebase.signUp).not.toHaveBeenCalled()
    })

    it('throws InviteAlreadyAcceptedError for a consumed invite', async () => {
      prisma.operatorInvite.findUnique.mockResolvedValue({
        ...pendingInvite(),
        status: InviteStatus.ACCEPTED,
      })
      await expect(service.accept('tok', 'password123')).rejects.toBeInstanceOf(
        InviteAlreadyAcceptedError,
      )
      expect(firebase.signUp).not.toHaveBeenCalled()
    })

    it('self-heals a lapsed PENDING invite to EXPIRED and throws InviteExpiredError', async () => {
      prisma.operatorInvite.findUnique.mockResolvedValue({ ...pendingInvite(), expiresAt: pastDate() })

      await expect(service.accept('tok', 'password123')).rejects.toBeInstanceOf(InviteExpiredError)
      expect(prisma.operatorInvite.update).toHaveBeenCalledWith({
        where: { id: 'inv-1' },
        data: { status: 'EXPIRED' },
      })
      expect(firebase.signUp).not.toHaveBeenCalled()
    })

    it('compensates by deleting the new identity when the attachment transaction fails', async () => {
      prisma.operatorInvite.findUnique.mockResolvedValue(pendingInvite())
      firebase.signUp.mockResolvedValue(authResult('user-new'))
      const boom = new Error('db down')
      prisma.$transaction.mockRejectedValue(boom)

      await expect(service.accept('tok', 'password123')).rejects.toBe(boom)
      expect(firebase.deleteUser).toHaveBeenCalledWith('user-new')
    })
  })
})
