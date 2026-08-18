import { createHash } from 'crypto'
import { ForbiddenException } from '@nestjs/common'
import type { ConfigService } from '@nestjs/config'
import type { IAuthProvider } from '@spark/auth'
import { DEFAULT_STAFF_SCOPES, type AuthResult, type AuthUser, type UserRole } from '@spark/types'
import {
  InviteStatus,
  OperatorInviteKind,
  OperatorMemberRole,
  OperatorStatus,
} from '@prisma/client'
import { OperatorScopeService } from '../common/authz/operator-scope.service'
import { RequestContext } from '../common/context/request-context'
import { OperatorSuspendedError, OperatorTargetRequiredError } from '../common/errors/domain.errors'
import { OperatorAccessService } from '../operators/operator-access.service'
import { OperatorNotFoundError } from '../operators/operators.types'
import type { PrismaService } from '../prisma/prisma.service'
import type { EntitlementService } from '../subscriptions/entitlement.service'
import type { NotificationsService } from '../notifications/notifications.service'
import { InviteService } from './invite.service'
import { InviteTokenService } from './invite-token.service'
import {
  InviteAlreadyAcceptedError,
  InviteEmailTakenError,
  InviteExpiredError,
  InviteNotFoundError,
  InviteNotResendableError,
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

const consumerUser: AuthUser = {
  id: 'cust-1',
  email: 'driver@spark.gr',
  role: 'user',
  emailVerified: true,
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

const futureDate = () => new Date(Date.now() + 60_000)
const pastDate = () => new Date(Date.now() - 60_000)

function authResult(userId: string, role: UserRole = 'operator_admin'): AuthResult {
  return {
    session: {
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: Date.now() + 60_000,
      user: { id: userId, email: 'new@spark.gr', role, emailVerified: false },
    },
  }
}

function tokenFrom(acceptUrl: string): string {
  return acceptUrl.split('/invite/accept/')[1]!
}

describe('InviteService', () => {
  let prisma: {
    parkingOperator: {
      create: jest.Mock
      update: jest.Mock
      delete: jest.Mock
      findUnique: jest.Mock
    }
    operatorInvite: {
      create: jest.Mock
      findUnique: jest.Mock
      findMany: jest.Mock
      update: jest.Mock
      updateMany: jest.Mock
    }
    operatorMembership: { create: jest.Mock; findUnique: jest.Mock; findMany: jest.Mock }
    user: { update: jest.Mock; findFirst: jest.Mock }
    auditLog: { create: jest.Mock }
    $transaction: jest.Mock
  }
  let tx: {
    parkingOperator: { create: jest.Mock; update: jest.Mock; deleteMany: jest.Mock }
    operatorInvite: {
      create: jest.Mock
      findMany: jest.Mock
      update: jest.Mock
      updateMany: jest.Mock
    }
    operatorMembership: { create: jest.Mock }
    user: { update: jest.Mock }
    auditLog: { create: jest.Mock }
    $executeRaw: jest.Mock
  }
  let entitlements: { assertCanAddStaffSeat: jest.Mock }
  let notifications: { sendOperatorInvite: jest.Mock; sendOperatorMemberInvite: jest.Mock }
  let config: { getOrThrow: jest.Mock }
  let firebase: { signUp: jest.Mock; deleteUser: jest.Mock }
  let service: InviteService

  /** Wires the caller's memberships into the real scope/access services under test. */
  function withMemberships(memberships: { operatorId: string; role: OperatorMemberRole }[]): void {
    prisma.operatorMembership.findMany.mockImplementation(
      ({ where }: { where: { role?: OperatorMemberRole } }) =>
        where.role ? memberships.filter((m) => m.role === where.role) : memberships,
    )
    prisma.operatorMembership.findUnique.mockImplementation(
      ({ where }: { where: { operatorId_userId: { operatorId: string } } }) =>
        memberships.find((m) => m.operatorId === where.operatorId_userId.operatorId) ?? null,
    )
  }

  beforeEach(() => {
    tx = {
      parkingOperator: {
        create: jest.fn(),
        update: jest.fn(),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      operatorInvite: {
        create: jest.fn(),
        // Nothing to supersede unless a test says otherwise.
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      operatorMembership: { create: jest.fn() },
      user: { update: jest.fn() },
      auditLog: { create: jest.fn() },
      $executeRaw: jest.fn().mockResolvedValue(0),
    }
    entitlements = { assertCanAddStaffSeat: jest.fn().mockResolvedValue(undefined) }
    prisma = {
      parkingOperator: {
        create: tx.parkingOperator.create,
        update: tx.parkingOperator.update,
        delete: jest.fn(),
        findUnique: jest.fn(),
      },
      operatorInvite: {
        create: tx.operatorInvite.create,
        findUnique: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      operatorMembership: {
        create: tx.operatorMembership.create,
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
      // Address free by default; the collision cases override it.
      user: { update: tx.user.update, findFirst: jest.fn().mockResolvedValue(null) },
      auditLog: { create: jest.fn() },
      $transaction: jest.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
    }
    notifications = {
      sendOperatorInvite: jest.fn().mockResolvedValue(true),
      sendOperatorMemberInvite: jest.fn().mockResolvedValue(true),
    }
    config = { getOrThrow: jest.fn().mockReturnValue('http://localhost:3000') }
    firebase = { signUp: jest.fn(), deleteUser: jest.fn().mockResolvedValue(undefined) }

    const prismaService = prisma as unknown as PrismaService
    service = new InviteService(
      prismaService,
      notifications as unknown as NotificationsService,
      config as unknown as ConfigService,
      new OperatorAccessService(prismaService, new OperatorScopeService(prismaService)),
      entitlements as unknown as EntitlementService,
      new InviteTokenService(config as unknown as ConfigService),
      firebase as unknown as IAuthProvider,
    )
  })

  describe('create', () => {
    it('creates a PENDING operator + invite, emails the accept link, never returns the raw token', async () => {
      tx.parkingOperator.create.mockResolvedValue({ id: 'op-new' })
      tx.operatorInvite.create.mockImplementation(
        ({ data }: { data: Record<string, unknown> }) => ({
          id: 'inv-1',
          email: data.email,
          businessName: data.businessName,
          status: InviteStatus.PENDING,
          kind: data.kind,
          role: data.role,
          operatorId: data.operatorId,
          expiresAt: data.expiresAt,
          createdAt: new Date(),
        }),
      )

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
      expect(inviteData.kind).toBe(OperatorInviteKind.ONBOARDING)
      expect(inviteData.role).toBe(OperatorMemberRole.ADMIN)

      const rawToken = tokenFrom(notifications.sendOperatorInvite.mock.calls[0]![0].acceptUrl)
      expect(rawToken).toMatch(/^[a-f0-9]{64}$/)
      // Only the hash is persisted; the raw token exists solely in the emailed link.
      expect(inviteData.tokenHash).toBe(sha256(rawToken))

      expect(summary).not.toHaveProperty('tokenHash')
      expect(summary).not.toHaveProperty('token')
      expect(JSON.stringify(summary)).not.toContain(rawToken)
      expect(summary).toMatchObject({
        id: 'inv-1',
        email: 'owner@biz.com',
        businessName: 'Biz Parking',
        kind: OperatorInviteKind.ONBOARDING,
        role: OperatorMemberRole.ADMIN,
        delivered: true,
      })
    })

    it('reports a failed delivery instead of swallowing it', async () => {
      tx.parkingOperator.create.mockResolvedValue({ id: 'op-new' })
      tx.operatorInvite.create.mockResolvedValue({
        id: 'inv-1',
        email: 'owner@biz.com',
        businessName: 'Biz Parking',
        status: InviteStatus.PENDING,
        kind: OperatorInviteKind.ONBOARDING,
        role: OperatorMemberRole.ADMIN,
        operatorId: 'op-new',
        expiresAt: futureDate(),
        createdAt: new Date(),
      })
      notifications.sendOperatorInvite.mockResolvedValue(false)

      const summary = await service.create(platformUser, {
        email: 'owner@biz.com',
        businessName: 'Biz Parking',
      })

      expect(summary.delivered).toBe(false)
    })

    it('writes exactly one invite.created audit row and never leaks the raw token', async () => {
      tx.parkingOperator.create.mockResolvedValue({ id: 'op-new' })
      tx.operatorInvite.create.mockResolvedValue({
        id: 'inv-1',
        email: 'owner@biz.com',
        businessName: 'Biz Parking',
        status: InviteStatus.PENDING,
        kind: OperatorInviteKind.ONBOARDING,
        role: OperatorMemberRole.ADMIN,
        operatorId: 'op-new',
        expiresAt: futureDate(),
        createdAt: new Date(),
      })

      await RequestContext.run({ ip: '198.51.100.4' }, () =>
        service.create(platformUser, { email: 'Owner@Biz.com', businessName: 'Biz Parking' }),
      )

      expect(tx.auditLog.create).toHaveBeenCalledTimes(1)
      const auditCall = tx.auditLog.create.mock.calls[0]![0]
      expect(auditCall.data).toMatchObject({
        actorId: 'admin-1',
        actorRole: 'platform_admin',
        action: 'invite.created',
        entityType: 'OperatorInvite',
        entityId: 'inv-1',
        ipAddress: '198.51.100.4',
      })
      const serialized = JSON.stringify(auditCall.data)
      expect(serialized).not.toMatch(/[a-f0-9]{64}/)
      expect(serialized).not.toContain('owner@biz.com')
    })

    it('rejects a non-platform-admin actor (service-layer re-check)', async () => {
      await expect(
        service.create(operatorUser, { email: 'a@b.com', businessName: 'X' }),
      ).rejects.toBeInstanceOf(ForbiddenException)
      expect(prisma.$transaction).not.toHaveBeenCalled()
    })
  })

  describe('createMember', () => {
    const verifiedOperator = (name = 'Biz A') => ({ name, status: OperatorStatus.VERIFIED })

    function captureInvite(): void {
      tx.operatorInvite.create.mockImplementation(
        ({ data }: { data: Record<string, unknown> }) => ({
          id: 'inv-m1',
          email: data.email,
          businessName: data.businessName,
          status: InviteStatus.PENDING,
          kind: data.kind,
          role: data.role,
          operatorId: data.operatorId,
          expiresAt: data.expiresAt,
          createdAt: new Date(),
          acceptedAt: null,
        }),
      )
    }

    it('lets an operator admin invite staff into their own operator', async () => {
      withMemberships([{ operatorId: 'op-a', role: OperatorMemberRole.ADMIN }])
      prisma.parkingOperator.findUnique.mockResolvedValue(verifiedOperator())
      captureInvite()

      const summary = await service.createMember(operatorUser, {
        email: 'Staff@Biz.com',
        role: OperatorMemberRole.STAFF,
        operatorId: 'op-a',
      })

      const data = tx.operatorInvite.create.mock.calls[0]![0].data
      expect(data).toMatchObject({
        email: 'staff@biz.com',
        operatorId: 'op-a',
        kind: OperatorInviteKind.MEMBER,
        role: OperatorMemberRole.STAFF,
        invitedById: 'op-1',
        businessName: 'Biz A',
      })
      // No shell operator: a member invite attaches to one that already exists.
      expect(tx.parkingOperator.create).not.toHaveBeenCalled()

      const rawToken = tokenFrom(notifications.sendOperatorMemberInvite.mock.calls[0]![0].acceptUrl)
      expect(data.tokenHash).toBe(sha256(rawToken))
      expect(notifications.sendOperatorMemberInvite.mock.calls[0]![0]).toMatchObject({
        to: 'staff@biz.com',
        isAdmin: false,
      })

      expect(JSON.stringify(summary)).not.toContain(rawToken)
      expect(summary).toMatchObject({
        kind: OperatorInviteKind.MEMBER,
        role: OperatorMemberRole.STAFF,
        operatorId: 'op-a',
        delivered: true,
      })
    })

    it('refuses the same call aimed at another tenant', async () => {
      withMemberships([{ operatorId: 'op-a', role: OperatorMemberRole.ADMIN }])

      await expect(
        service.createMember(operatorUser, {
          email: 'staff@biz.com',
          role: OperatorMemberRole.STAFF,
          operatorId: 'op-b',
        }),
      ).rejects.toBeInstanceOf(OperatorNotFoundError)

      expect(prisma.$transaction).not.toHaveBeenCalled()
      expect(tx.operatorInvite.create).not.toHaveBeenCalled()
      expect(notifications.sendOperatorMemberInvite).not.toHaveBeenCalled()
    })

    it('never silently redirects a single-membership caller to their own operator', async () => {
      withMemberships([{ operatorId: 'op-a', role: OperatorMemberRole.ADMIN }])
      prisma.parkingOperator.findUnique.mockResolvedValue(verifiedOperator())
      captureInvite()

      await expect(
        service.createMember(operatorUser, {
          email: 'staff@biz.com',
          role: OperatorMemberRole.STAFF,
          operatorId: 'op-b',
        }),
      ).rejects.toBeInstanceOf(OperatorNotFoundError)
      expect(tx.operatorInvite.create).not.toHaveBeenCalled()
    })

    it('requires a multi-membership admin to name a target, inferring none', async () => {
      withMemberships([
        { operatorId: 'op-a', role: OperatorMemberRole.ADMIN },
        { operatorId: 'op-b', role: OperatorMemberRole.ADMIN },
      ])

      await expect(
        service.createMember(operatorUser, {
          email: 'staff@biz.com',
          role: OperatorMemberRole.STAFF,
        }),
      ).rejects.toBeInstanceOf(OperatorTargetRequiredError)
      expect(tx.operatorInvite.create).not.toHaveBeenCalled()
    })

    it('accepts a multi-membership admin who names one of their own operators', async () => {
      withMemberships([
        { operatorId: 'op-a', role: OperatorMemberRole.ADMIN },
        { operatorId: 'op-b', role: OperatorMemberRole.ADMIN },
      ])
      prisma.parkingOperator.findUnique.mockResolvedValue(verifiedOperator('Biz B'))
      captureInvite()

      await service.createMember(operatorUser, {
        email: 'staff@biz.com',
        role: OperatorMemberRole.STAFF,
        operatorId: 'op-b',
      })

      expect(tx.operatorInvite.create.mock.calls[0]![0].data.operatorId).toBe('op-b')
    })

    it('infers the operator for a single-membership admin who names none', async () => {
      withMemberships([{ operatorId: 'op-a', role: OperatorMemberRole.ADMIN }])
      prisma.parkingOperator.findUnique.mockResolvedValue(verifiedOperator())
      captureInvite()

      await service.createMember(operatorUser, {
        email: 'staff@biz.com',
        role: OperatorMemberRole.STAFF,
      })

      expect(tx.operatorInvite.create.mock.calls[0]![0].data.operatorId).toBe('op-a')
    })

    it('refuses a caller who is only STAFF of the target operator', async () => {
      withMemberships([{ operatorId: 'op-a', role: OperatorMemberRole.STAFF }])

      await expect(
        service.createMember(operatorUser, {
          email: 'staff@biz.com',
          role: OperatorMemberRole.STAFF,
          operatorId: 'op-a',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException)
      expect(tx.operatorInvite.create).not.toHaveBeenCalled()
    })

    it('refuses a consumer account outright (service-layer re-check)', async () => {
      await expect(
        service.createMember(consumerUser, {
          email: 'staff@biz.com',
          role: OperatorMemberRole.STAFF,
          operatorId: 'op-a',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException)
      expect(prisma.operatorMembership.findMany).not.toHaveBeenCalled()
    })

    it('refuses to add people to a suspended operator', async () => {
      withMemberships([{ operatorId: 'op-a', role: OperatorMemberRole.ADMIN }])
      prisma.parkingOperator.findUnique.mockResolvedValue({
        name: 'Biz A',
        status: OperatorStatus.SUSPENDED,
      })

      await expect(
        service.createMember(operatorUser, {
          email: 'staff@biz.com',
          role: OperatorMemberRole.STAFF,
          operatorId: 'op-a',
        }),
      ).rejects.toBeInstanceOf(OperatorSuspendedError)
      expect(tx.operatorInvite.create).not.toHaveBeenCalled()
    })

    it('writes one invite.created audit row carrying no token and no invitee email', async () => {
      withMemberships([{ operatorId: 'op-a', role: OperatorMemberRole.ADMIN }])
      prisma.parkingOperator.findUnique.mockResolvedValue(verifiedOperator())
      captureInvite()

      await RequestContext.run({ ip: '198.51.100.9' }, () =>
        service.createMember(operatorUser, {
          email: 'staff@biz.com',
          role: OperatorMemberRole.STAFF,
          operatorId: 'op-a',
        }),
      )

      expect(tx.auditLog.create).toHaveBeenCalledTimes(1)
      const auditCall = tx.auditLog.create.mock.calls[0]![0]
      expect(auditCall.data).toMatchObject({
        actorId: 'op-1',
        actorRole: 'operator_admin',
        action: 'invite.created',
        entityType: 'OperatorInvite',
        entityId: 'inv-m1',
        payload: { operatorId: 'op-a', kind: 'MEMBER', role: 'STAFF' },
        ipAddress: '198.51.100.9',
      })
      const serialized = JSON.stringify(auditCall.data)
      expect(serialized).not.toMatch(/[a-f0-9]{64}/)
      expect(serialized).not.toContain('staff@biz.com')
    })
  })

  describe('list', () => {
    it('returns every invite to a platform admin, without leaking the token hash', async () => {
      prisma.operatorInvite.findMany.mockResolvedValue([
        {
          id: 'inv-2',
          email: 'b@biz.com',
          businessName: 'Biz B',
          status: InviteStatus.PENDING,
          kind: OperatorInviteKind.ONBOARDING,
          role: OperatorMemberRole.ADMIN,
          operatorId: 'op-b',
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
          kind: OperatorInviteKind.ONBOARDING,
          role: OperatorMemberRole.ADMIN,
          operatorId: 'op-b',
          expiresAt: expect.any(Date),
          createdAt: new Date('2026-01-02'),
          acceptedAt: null,
        },
      ])
    })

    it('narrows an operator admin to the member invites of operators they admin', async () => {
      withMemberships([
        { operatorId: 'op-a', role: OperatorMemberRole.ADMIN },
        { operatorId: 'op-c', role: OperatorMemberRole.STAFF },
      ])
      prisma.operatorInvite.findMany.mockResolvedValue([])

      await service.list(operatorUser)

      expect(prisma.operatorInvite.findMany).toHaveBeenCalledWith({
        where: { operatorId: { in: ['op-a'] }, kind: OperatorInviteKind.MEMBER },
        orderBy: { createdAt: 'desc' },
      })
    })

    it('rejects a consumer actor (service-layer re-check)', async () => {
      await expect(service.list(consumerUser)).rejects.toBeInstanceOf(ForbiddenException)
      expect(prisma.operatorInvite.findMany).not.toHaveBeenCalled()
    })
  })

  describe('revoke', () => {
    const onboarding = { kind: OperatorInviteKind.ONBOARDING, operatorId: 'op-new' }

    it('flips the invite to REVOKED and deletes its unclaimed PENDING operator', async () => {
      prisma.operatorInvite.findUnique
        .mockResolvedValueOnce(onboarding)
        .mockResolvedValue({ operatorId: 'op-new', operator: { status: 'PENDING' } })
      prisma.operatorInvite.updateMany.mockResolvedValue({ count: 1 })

      await expect(service.revoke(platformUser, 'inv-1')).resolves.toBeUndefined()

      expect(prisma.operatorInvite.updateMany).toHaveBeenCalledWith({
        where: { id: 'inv-1', status: InviteStatus.PENDING },
        data: { status: InviteStatus.REVOKED },
      })
      expect(prisma.parkingOperator.delete).toHaveBeenCalledWith({ where: { id: 'op-new' } })
    })

    it('never deletes the shared operator behind a member invite', async () => {
      withMemberships([{ operatorId: 'op-a', role: OperatorMemberRole.ADMIN }])
      prisma.operatorInvite.findUnique.mockResolvedValue({
        kind: OperatorInviteKind.MEMBER,
        operatorId: 'op-a',
      })
      prisma.operatorInvite.updateMany.mockResolvedValue({ count: 1 })

      await service.revoke(operatorUser, 'inv-m1')

      expect(prisma.parkingOperator.delete).not.toHaveBeenCalled()
    })

    it('refuses to revoke another tenant’s member invite', async () => {
      withMemberships([{ operatorId: 'op-a', role: OperatorMemberRole.ADMIN }])
      prisma.operatorInvite.findUnique.mockResolvedValue({
        kind: OperatorInviteKind.MEMBER,
        operatorId: 'op-b',
      })

      await expect(service.revoke(operatorUser, 'inv-m1')).rejects.toBeInstanceOf(
        OperatorNotFoundError,
      )
      expect(prisma.operatorInvite.updateMany).not.toHaveBeenCalled()
    })

    it('writes exactly one invite.revoked audit row for the actor', async () => {
      prisma.operatorInvite.findUnique
        .mockResolvedValueOnce(onboarding)
        .mockResolvedValue({ operatorId: 'op-new', operator: { status: 'PENDING' } })
      prisma.operatorInvite.updateMany.mockResolvedValue({ count: 1 })

      await service.revoke(platformUser, 'inv-1')

      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1)
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: {
          actorId: 'admin-1',
          actorRole: 'platform_admin',
          action: 'invite.revoked',
          entityType: 'OperatorInvite',
          entityId: 'inv-1',
          payload: undefined,
          ipAddress: null,
        },
      })
    })

    it('writes no audit row when the revoke is rejected', async () => {
      prisma.operatorInvite.findUnique
        .mockResolvedValueOnce(onboarding)
        .mockResolvedValue({ status: InviteStatus.EXPIRED })
      prisma.operatorInvite.updateMany.mockResolvedValue({ count: 0 })

      await expect(service.revoke(platformUser, 'inv-1')).rejects.toBeInstanceOf(
        InviteNotRevocableError,
      )
      expect(prisma.auditLog.create).not.toHaveBeenCalled()
    })

    it('leaves an already-claimed operator alone', async () => {
      prisma.operatorInvite.findUnique
        .mockResolvedValueOnce(onboarding)
        .mockResolvedValue({ operatorId: 'op-new', operator: { status: 'VERIFIED' } })
      prisma.operatorInvite.updateMany.mockResolvedValue({ count: 1 })

      await service.revoke(platformUser, 'inv-1')

      expect(prisma.parkingOperator.delete).not.toHaveBeenCalled()
    })

    it('throws InviteNotFoundError when no invite matches the id', async () => {
      prisma.operatorInvite.findUnique.mockResolvedValue(null)

      await expect(service.revoke(platformUser, 'nope')).rejects.toBeInstanceOf(InviteNotFoundError)
      expect(prisma.parkingOperator.delete).not.toHaveBeenCalled()
    })

    it('loses the accept-vs-revoke race cleanly with InviteAlreadyAcceptedError', async () => {
      prisma.operatorInvite.findUnique
        .mockResolvedValueOnce(onboarding)
        .mockResolvedValue({ status: InviteStatus.ACCEPTED })
      prisma.operatorInvite.updateMany.mockResolvedValue({ count: 0 })

      await expect(service.revoke(platformUser, 'inv-1')).rejects.toBeInstanceOf(
        InviteAlreadyAcceptedError,
      )
      expect(prisma.parkingOperator.delete).not.toHaveBeenCalled()
    })

    it('rejects a non-platform-admin actor on an onboarding invite', async () => {
      withMemberships([{ operatorId: 'op-new', role: OperatorMemberRole.ADMIN }])
      prisma.operatorInvite.findUnique.mockResolvedValue(onboarding)

      await expect(service.revoke(operatorUser, 'inv-1')).rejects.toBeInstanceOf(ForbiddenException)
      expect(prisma.operatorInvite.updateMany).not.toHaveBeenCalled()
    })
  })

  describe('resend', () => {
    const pendingMemberInvite = (overrides: Record<string, unknown> = {}) => ({
      id: 'inv-m1',
      email: 'staff@biz.com',
      businessName: 'Biz A',
      operatorId: 'op-a',
      kind: OperatorInviteKind.MEMBER,
      role: OperatorMemberRole.STAFF,
      tokenHash: sha256('old-token'),
      status: InviteStatus.PENDING,
      expiresAt: futureDate(),
      createdAt: new Date('2026-01-01'),
      acceptedAt: null,
      ...overrides,
    })

    it('rotates the token so the previous link stops working, and extends the window', async () => {
      withMemberships([{ operatorId: 'op-a', role: OperatorMemberRole.ADMIN }])
      const invite = pendingMemberInvite()
      prisma.operatorInvite.findUnique.mockResolvedValue(invite)

      const before = Date.now()
      const summary = await service.resend(operatorUser, 'inv-m1')

      const newRawToken = tokenFrom(
        notifications.sendOperatorMemberInvite.mock.calls[0]![0].acceptUrl,
      )
      expect(newRawToken).toMatch(/^[a-f0-9]{64}$/)
      expect(newRawToken).not.toBe('old-token')

      const update = tx.operatorInvite.updateMany.mock.calls[0]![0]
      // Conditional on the hash that was read, and overwriting it is the invalidation:
      // the old hash no longer exists in the table, so the old link resolves to nothing.
      expect(update.where).toEqual({
        id: 'inv-m1',
        tokenHash: sha256('old-token'),
        status: { in: [InviteStatus.PENDING, InviteStatus.EXPIRED] },
      })
      expect(update.data.tokenHash).toBe(sha256(newRawToken))
      expect(update.data.status).toBe(InviteStatus.PENDING)
      expect(update.data.expiresAt.getTime()).toBeGreaterThan(before + 6 * 24 * 60 * 60 * 1000)

      // The rotated row: the previously emailed link now matches no invite at all.
      prisma.operatorInvite.findUnique.mockImplementation(
        ({ where }: { where: { tokenHash?: string } }) =>
          where.tokenHash === sha256(newRawToken)
            ? { ...invite, tokenHash: sha256(newRawToken) }
            : null,
      )
      await expect(service.validate('old-token')).rejects.toBeInstanceOf(InviteNotFoundError)
      await expect(service.accept('old-token', 'password123')).rejects.toBeInstanceOf(
        InviteNotFoundError,
      )
      expect(firebase.signUp).not.toHaveBeenCalled()

      expect(JSON.stringify(summary)).not.toContain(newRawToken)
      expect(summary).toMatchObject({ status: InviteStatus.PENDING, delivered: true })
    })

    it('revives a lapsed invite rather than stranding the business behind it', async () => {
      withMemberships([{ operatorId: 'op-a', role: OperatorMemberRole.ADMIN }])
      prisma.operatorInvite.findUnique.mockResolvedValue(
        pendingMemberInvite({ status: InviteStatus.EXPIRED, expiresAt: pastDate() }),
      )

      const summary = await service.resend(operatorUser, 'inv-m1')

      expect(summary.status).toBe(InviteStatus.PENDING)
      expect(summary.expiresAt.getTime()).toBeGreaterThan(Date.now())
    })

    it('writes one invite.resent audit row that carries no token', async () => {
      withMemberships([{ operatorId: 'op-a', role: OperatorMemberRole.ADMIN }])
      prisma.operatorInvite.findUnique.mockResolvedValue(pendingMemberInvite())

      await RequestContext.run({ ip: '203.0.113.4' }, () => service.resend(operatorUser, 'inv-m1'))

      expect(tx.auditLog.create).toHaveBeenCalledTimes(1)
      const auditCall = tx.auditLog.create.mock.calls[0]![0]
      expect(auditCall.data).toMatchObject({
        actorId: 'op-1',
        actorRole: 'operator_admin',
        action: 'invite.resent',
        entityType: 'OperatorInvite',
        entityId: 'inv-m1',
        payload: { operatorId: 'op-a', kind: 'MEMBER', role: 'STAFF' },
        ipAddress: '203.0.113.4',
      })
      const serialized = JSON.stringify(auditCall.data)
      expect(serialized).not.toMatch(/[a-f0-9]{64}/)
      expect(serialized).not.toContain('staff@biz.com')
    })

    it('reports a failed re-delivery', async () => {
      withMemberships([{ operatorId: 'op-a', role: OperatorMemberRole.ADMIN }])
      prisma.operatorInvite.findUnique.mockResolvedValue(pendingMemberInvite())
      notifications.sendOperatorMemberInvite.mockResolvedValue(false)

      await expect(service.resend(operatorUser, 'inv-m1')).resolves.toMatchObject({
        delivered: false,
      })
    })

    it('refuses an accepted invite', async () => {
      withMemberships([{ operatorId: 'op-a', role: OperatorMemberRole.ADMIN }])
      prisma.operatorInvite.findUnique.mockResolvedValue(
        pendingMemberInvite({ status: InviteStatus.ACCEPTED }),
      )

      await expect(service.resend(operatorUser, 'inv-m1')).rejects.toBeInstanceOf(
        InviteAlreadyAcceptedError,
      )
      expect(tx.operatorInvite.updateMany).not.toHaveBeenCalled()
    })

    it('refuses a revoked invite', async () => {
      withMemberships([{ operatorId: 'op-a', role: OperatorMemberRole.ADMIN }])
      prisma.operatorInvite.findUnique.mockResolvedValue(
        pendingMemberInvite({ status: InviteStatus.REVOKED }),
      )

      await expect(service.resend(operatorUser, 'inv-m1')).rejects.toBeInstanceOf(
        InviteNotResendableError,
      )
      expect(tx.operatorInvite.updateMany).not.toHaveBeenCalled()
    })

    it('loses a concurrent rotation rather than overwriting the link it emailed', async () => {
      withMemberships([{ operatorId: 'op-a', role: OperatorMemberRole.ADMIN }])
      prisma.operatorInvite.findUnique.mockResolvedValue(pendingMemberInvite())
      tx.operatorInvite.updateMany.mockResolvedValue({ count: 0 })

      await expect(service.resend(operatorUser, 'inv-m1')).rejects.toBeInstanceOf(
        InviteNotResendableError,
      )
      expect(notifications.sendOperatorMemberInvite).not.toHaveBeenCalled()
    })

    it('refuses another tenant’s member invite', async () => {
      withMemberships([{ operatorId: 'op-a', role: OperatorMemberRole.ADMIN }])
      prisma.operatorInvite.findUnique.mockResolvedValue(
        pendingMemberInvite({ operatorId: 'op-b' }),
      )

      await expect(service.resend(operatorUser, 'inv-m1')).rejects.toBeInstanceOf(
        OperatorNotFoundError,
      )
      expect(tx.operatorInvite.updateMany).not.toHaveBeenCalled()
    })

    it('refuses an operator admin an onboarding invite, and re-sends it for a platform admin', async () => {
      withMemberships([{ operatorId: 'op-new', role: OperatorMemberRole.ADMIN }])
      prisma.operatorInvite.findUnique.mockResolvedValue(
        pendingMemberInvite({
          kind: OperatorInviteKind.ONBOARDING,
          role: OperatorMemberRole.ADMIN,
          operatorId: 'op-new',
        }),
      )

      await expect(service.resend(operatorUser, 'inv-1')).rejects.toBeInstanceOf(ForbiddenException)
      expect(tx.operatorInvite.updateMany).not.toHaveBeenCalled()

      await service.resend(platformUser, 'inv-1')
      expect(notifications.sendOperatorInvite).toHaveBeenCalledTimes(1)
      expect(notifications.sendOperatorMemberInvite).not.toHaveBeenCalled()
    })

    it('throws InviteNotFoundError for an unknown id', async () => {
      prisma.operatorInvite.findUnique.mockResolvedValue(null)
      await expect(service.resend(platformUser, 'nope')).rejects.toBeInstanceOf(InviteNotFoundError)
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
        role: OperatorMemberRole.STAFF,
        status: InviteStatus.PENDING,
        expiresAt: futureDate(),
      })
      await expect(service.validate('tok')).resolves.toEqual({
        businessName: 'Biz',
        email: 'a@b.com',
        role: OperatorMemberRole.STAFF,
        expired: false,
      })
    })

    it('reports expired for an already-accepted invite', async () => {
      prisma.operatorInvite.findUnique.mockResolvedValue({
        businessName: 'Biz',
        email: 'a@b.com',
        role: OperatorMemberRole.ADMIN,
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
      kind: OperatorInviteKind.ONBOARDING,
      role: OperatorMemberRole.ADMIN,
      tokenHash: sha256('tok'),
      status: InviteStatus.PENDING,
      expiresAt: futureDate(),
    })

    const pendingStaffInvite = () => ({
      ...pendingInvite(),
      id: 'inv-m1',
      businessName: 'Biz A',
      operatorId: 'op-a',
      kind: OperatorInviteKind.MEMBER,
      role: OperatorMemberRole.STAFF,
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
        // An admin stores no scopes: their set is derived, so a scope added to the product
        // later applies to them rather than being missing from a row written before it.
        data: { operatorId: 'op-new', userId: 'user-new', role: 'ADMIN', scopes: [] },
      })
      expect(tx.parkingOperator.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'op-new' },
          data: expect.objectContaining({ status: 'VERIFIED' }),
        }),
      )
      expect(tx.user.update).toHaveBeenCalledWith({
        where: { id: 'user-new' },
        data: { emailVerified: true },
      })
      expect(tx.operatorInvite.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'inv-1', tokenHash: sha256('tok'), status: InviteStatus.PENDING },
          data: expect.objectContaining({ status: 'ACCEPTED' }),
        }),
      )
      expect(firebase.deleteUser).not.toHaveBeenCalled()
      expect(result).toBe(expected)
    })

    it('yields operator_staff and a STAFF membership for a staff invite, leaving the operator untouched', async () => {
      prisma.operatorInvite.findUnique.mockResolvedValue(pendingStaffInvite())
      prisma.parkingOperator.findUnique.mockResolvedValue({ status: OperatorStatus.VERIFIED })
      firebase.signUp.mockResolvedValue(authResult('user-staff', 'operator_staff'))

      await service.accept('tok', 'password123')

      expect(firebase.signUp).toHaveBeenCalledWith({
        email: 'new@spark.gr',
        password: 'password123',
        // The employer's name is not the employee's display name.
        displayName: undefined,
        role: 'operator_staff',
      })
      expect(tx.operatorMembership.create).toHaveBeenCalledWith({
        // Staff arrive with the same default set the scopes migration backfilled onto
        // existing ones — otherwise everyone invited after it would arrive able to do
        // nothing at all.
        data: {
          operatorId: 'op-a',
          userId: 'user-staff',
          role: OperatorMemberRole.STAFF,
          scopes: [...DEFAULT_STAFF_SCOPES],
        },
      })
      // A member invite must never verify, re-verify or otherwise touch its operator.
      expect(tx.parkingOperator.update).not.toHaveBeenCalled()
      expect(tx.auditLog.create.mock.calls[0]![0].data).toMatchObject({
        actorRole: 'operator_staff',
        action: 'invite.accepted',
        payload: { operatorId: 'op-a', kind: 'MEMBER', role: 'STAFF' },
      })
    })

    it('refuses a staff invite into an operator suspended since it was issued', async () => {
      prisma.operatorInvite.findUnique.mockResolvedValue(pendingStaffInvite())
      prisma.parkingOperator.findUnique.mockResolvedValue({ status: OperatorStatus.SUSPENDED })

      await expect(service.accept('tok', 'password123')).rejects.toBeInstanceOf(InviteExpiredError)
      expect(firebase.signUp).not.toHaveBeenCalled()
    })

    it('rolls the whole attempt back when the invite was rotated or revoked mid-flight', async () => {
      prisma.operatorInvite.findUnique.mockResolvedValue(pendingInvite())
      firebase.signUp.mockResolvedValue(authResult('user-new'))
      tx.operatorInvite.updateMany.mockResolvedValue({ count: 0 })

      await expect(service.accept('tok', 'password123')).rejects.toBeInstanceOf(InviteExpiredError)
      expect(firebase.deleteUser).toHaveBeenCalledWith('user-new')
      expect(tx.auditLog.create).not.toHaveBeenCalled()
    })

    it('writes exactly one invite.accepted audit row for the newly provisioned identity, never the password', async () => {
      prisma.operatorInvite.findUnique.mockResolvedValue(pendingInvite())
      firebase.signUp.mockResolvedValue(authResult('user-new'))

      await RequestContext.run({ ip: '192.0.2.7' }, () => service.accept('tok', 'p4ssw0rd!'))

      expect(tx.auditLog.create).toHaveBeenCalledTimes(1)
      const auditCall = tx.auditLog.create.mock.calls[0]![0]
      expect(auditCall.data).toMatchObject({
        actorId: 'user-new',
        actorRole: 'operator_admin',
        action: 'invite.accepted',
        entityType: 'OperatorInvite',
        entityId: 'inv-1',
        payload: { operatorId: 'op-new' },
        ipAddress: '192.0.2.7',
      })
      expect(JSON.stringify(auditCall.data)).not.toContain('p4ssw0rd!')
      expect(JSON.stringify(auditCall.data)).not.toMatch(/[a-f0-9]{64}/)
    })

    it('rolls back the accept transaction (and triggers identity cleanup) when the audit write inside it fails', async () => {
      prisma.operatorInvite.findUnique.mockResolvedValue(pendingInvite())
      firebase.signUp.mockResolvedValue(authResult('user-new'))
      const boom = new Error('audit insert failed')
      tx.auditLog.create.mockRejectedValue(boom)

      await expect(service.accept('tok', 'password123')).rejects.toBe(boom)

      // The audit write shares the `tx` client with the membership/status/invite writes,
      // so a real database rolls all of them back together; the compensating Firebase
      // cleanup firing here is the observable proof the whole attempt was treated as failed.
      expect(firebase.deleteUser).toHaveBeenCalledWith('user-new')
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
      prisma.operatorInvite.findUnique.mockResolvedValue({
        ...pendingInvite(),
        expiresAt: pastDate(),
      })

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

  const verifiedOperator = (name = 'Biz A') => ({ name, status: OperatorStatus.VERIFIED })

  const inviteRow = () => ({
    id: 'inv-1',
    email: 'owner@biz.com',
    businessName: 'Biz Parking',
    operatorId: 'op-new',
    kind: OperatorInviteKind.ONBOARDING,
    role: OperatorMemberRole.ADMIN,
    status: InviteStatus.PENDING,
    expiresAt: futureDate(),
    createdAt: new Date(),
    acceptedAt: null,
  })

  const pendingInvite = () => ({
    ...inviteRow(),
    email: 'new@spark.gr',
    tokenHash: sha256('tok'),
  })

  describe('an address that already has an account', () => {
    /**
     * The collision used to surface only at redeem, from the identity provider, as a bare
     * 409 the accept page could not distinguish from a link that really had been used. By
     * then the mail had gone out and a shell operator existed. Refusing at issue puts it in
     * front of the one person who can act on it.
     */
    it('is refused at issue, before a shell operator or an email exists', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'existing' })

      await expect(
        service.create(platformUser, { email: 'Owner@Biz.com', businessName: 'Biz Parking' }),
      ).rejects.toBeInstanceOf(InviteEmailTakenError)

      expect(tx.parkingOperator.create).not.toHaveBeenCalled()
      expect(tx.operatorInvite.create).not.toHaveBeenCalled()
      expect(notifications.sendOperatorInvite).not.toHaveBeenCalled()
    })

    it('is refused at issue for a member invite, before a seat is spent', async () => {
      prisma.parkingOperator.findUnique.mockResolvedValue(verifiedOperator())
      prisma.user.findFirst.mockResolvedValue({ id: 'existing' })
      withMemberships([{ operatorId: 'op-a', role: OperatorMemberRole.ADMIN }])

      await expect(
        service.createMember(operatorUser, {
          email: 'staff@biz.com',
          role: OperatorMemberRole.STAFF,
          operatorId: 'op-a',
        }),
      ).rejects.toBeInstanceOf(InviteEmailTakenError)

      expect(entitlements.assertCanAddStaffSeat).not.toHaveBeenCalled()
      expect(tx.operatorInvite.create).not.toHaveBeenCalled()
    })

    // Seven days is long enough for the address to sign up on its own in the meantime.
    it('is refused again at redeem, before any identity is provisioned', async () => {
      prisma.operatorInvite.findUnique.mockResolvedValue(pendingInvite())
      prisma.user.findFirst.mockResolvedValue({ id: 'existing' })

      await expect(service.accept('tok', 'password123')).rejects.toBeInstanceOf(
        InviteEmailTakenError,
      )
      expect(firebase.signUp).not.toHaveBeenCalled()
    })

    /**
     * Purge anonymises the address away and destroys the identity-provider credential with
     * it, so nothing owns it any more. The query still looks across every lifecycle state —
     * it is the anonymised email, not an exclusion here, that stops a purged row matching.
     */
    it('does not count a purged account, so that address can be invited again', async () => {
      tx.parkingOperator.create.mockResolvedValue({ id: 'op-new' })
      tx.operatorInvite.create.mockResolvedValue(inviteRow())

      await service.create(platformUser, { email: 'owner@biz.com', businessName: 'Biz Parking' })

      const where = prisma.user.findFirst.mock.calls[0]![0].where as Record<string, unknown>
      expect(where).toMatchObject({ email: 'owner@biz.com' })
      expect(where).toHaveProperty('lifecycleStatus')
      expect(tx.operatorInvite.create).toHaveBeenCalled()
    })
  })

  describe('superseding earlier invites', () => {
    /**
     * Tokens were always unique per row; what was missing was that only the newest is
     * valid. Left live, an earlier link is a second redeemable grant to the same address —
     * so revoking the invite visible in the UI withdraws nothing.
     */
    it('retires the earlier live invite when a replacement is issued', async () => {
      tx.operatorInvite.findMany.mockResolvedValue([{ id: 'inv-old', operatorId: 'op-old' }])
      tx.parkingOperator.create.mockResolvedValue({ id: 'op-new' })
      tx.operatorInvite.create.mockResolvedValue(inviteRow())

      await service.create(platformUser, { email: 'owner@biz.com', businessName: 'Biz Parking' })

      expect(tx.operatorInvite.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            email: 'owner@biz.com',
            kind: OperatorInviteKind.ONBOARDING,
            status: InviteStatus.PENDING,
          },
        }),
      )
      expect(tx.operatorInvite.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['inv-old'] }, status: InviteStatus.PENDING },
        data: { status: InviteStatus.REVOKED },
      })
    })

    // The same cleanup revoke() performs, guarded harder because this deletes a set.
    it('drops the retired invite unclaimed shell operator, and only an unclaimed one', async () => {
      tx.operatorInvite.findMany.mockResolvedValue([{ id: 'inv-old', operatorId: 'op-old' }])
      tx.parkingOperator.create.mockResolvedValue({ id: 'op-new' })
      tx.operatorInvite.create.mockResolvedValue(inviteRow())

      await service.create(platformUser, { email: 'owner@biz.com', businessName: 'Biz Parking' })

      expect(tx.parkingOperator.deleteMany).toHaveBeenCalledWith({
        where: {
          id: { in: ['op-old'] },
          status: OperatorStatus.PENDING,
          memberships: { none: {} },
          facilities: { none: {} },
        },
      })
    })

    it('records the retirement against each superseded invite', async () => {
      tx.operatorInvite.findMany.mockResolvedValue([
        { id: 'inv-old', operatorId: null },
        { id: 'inv-older', operatorId: null },
      ])
      tx.parkingOperator.create.mockResolvedValue({ id: 'op-new' })
      tx.operatorInvite.create.mockResolvedValue(inviteRow())

      await service.create(platformUser, { email: 'owner@biz.com', businessName: 'Biz Parking' })

      const superseded = tx.auditLog.create.mock.calls
        .map((call) => call[0].data as { action: string; entityId: string })
        .filter((data) => data.action === 'invite.superseded')
      expect(superseded.map((data) => data.entityId)).toEqual(['inv-old', 'inv-older'])
    })

    /**
     * Under the operator lock and before the seat check: re-inviting an address the operator
     * already has a live invite out to must cost the seat it already spent, not a second one.
     */
    it('retires the earlier member invite before the seat quota is consulted', async () => {
      prisma.parkingOperator.findUnique.mockResolvedValue(verifiedOperator())
      withMemberships([{ operatorId: 'op-a', role: OperatorMemberRole.ADMIN }])
      tx.operatorInvite.findMany.mockResolvedValue([{ id: 'inv-old', operatorId: 'op-a' }])
      tx.operatorInvite.create.mockResolvedValue(inviteRow())

      await service.createMember(operatorUser, {
        email: 'staff@biz.com',
        role: OperatorMemberRole.STAFF,
        operatorId: 'op-a',
      })

      expect(tx.operatorInvite.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            email: 'staff@biz.com',
            kind: OperatorInviteKind.MEMBER,
            operatorId: 'op-a',
            status: InviteStatus.PENDING,
          },
        }),
      )
      expect(tx.operatorInvite.updateMany.mock.invocationCallOrder[0]!).toBeLessThan(
        entitlements.assertCanAddStaffSeat.mock.invocationCallOrder[0]!,
      )
    })

    it('touches nothing when the address has no live invite', async () => {
      tx.parkingOperator.create.mockResolvedValue({ id: 'op-new' })
      tx.operatorInvite.create.mockResolvedValue(inviteRow())

      await service.create(platformUser, { email: 'owner@biz.com', businessName: 'Biz Parking' })

      expect(tx.operatorInvite.updateMany).not.toHaveBeenCalled()
      expect(tx.parkingOperator.deleteMany).not.toHaveBeenCalled()
    })
  })

})
