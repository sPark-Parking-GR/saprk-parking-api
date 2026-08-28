import { ForbiddenException } from '@nestjs/common'
import { OperatorMemberRole, OperatorStatus, UserRole } from '@prisma/client'
import { DEFAULT_STAFF_SCOPES, type AuthUser } from '@spark/types'
import { OperatorScopeService } from '../common/authz/operator-scope.service'
import { RequestContext } from '../common/context/request-context'
import {
  OperatorTargetRequiredError,
  SubscriptionFeatureRequiredError,
} from '../common/errors/domain.errors'
import type { PrismaService } from '../prisma/prisma.service'
import type { EntitlementService } from '../subscriptions/entitlement.service'
import { OperatorAccessService } from './operator-access.service'
import { OperatorMembersService } from './operator-members.service'
import {
  AdminScopesNotEditableError,
  LastOperatorAdminError,
  OperatorMemberNotFoundError,
  OperatorNotFoundError,
  SelfMembershipRemovalError,
  SelfRoleChangeError,
  StaffScopeNotGrantableError,
} from './operators.types'

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

describe('OperatorMembersService', () => {
  let prisma: {
    operatorMembership: {
      findUnique: jest.Mock
      findMany: jest.Mock
      count: jest.Mock
      update: jest.Mock
      delete: jest.Mock
    }
    parkingOperator: { findUnique: jest.Mock }
    user: { findUnique: jest.Mock; update: jest.Mock }
    facilityManager: { deleteMany: jest.Mock }
    tariffPlanManager: { deleteMany: jest.Mock }
    auditLog: { create: jest.Mock }
    $executeRaw: jest.Mock
    $transaction: jest.Mock
  }
  let entitlements: { hasFeature: jest.Mock }
  let service: OperatorMembersService

  /** Callers' own memberships, which drive both scope resolution and the ADMIN check. */
  function withCallerMemberships(
    memberships: { operatorId: string; role: OperatorMemberRole }[],
  ): void {
    prisma.operatorMembership.findMany.mockImplementation(
      ({ where }: { where: { userId: string; role?: OperatorMemberRole } }) => {
        if (where.userId !== operatorUser.id) return []
        return where.role ? memberships.filter((m) => m.role === where.role) : memberships
      },
    )
  }

  /** The membership row the endpoint is acting on. */
  function targetMembership(role: OperatorMemberRole, userId = 'user-2'): void {
    prisma.operatorMembership.findUnique.mockImplementation(
      ({ where }: { where: { operatorId_userId: { operatorId: string; userId: string } } }) => {
        const key = where.operatorId_userId
        if (key.userId === userId) {
          return {
            id: 'mem-2',
            role,
            scopes: [],
            createdAt: new Date('2026-02-01'),
            user: { email: 'member@biz.gr' },
          }
        }
        if (key.userId === operatorUser.id && key.operatorId === 'op-a') {
          return { id: 'mem-1', role: OperatorMemberRole.ADMIN, scopes: [] }
        }
        return null
      },
    )
  }

  beforeEach(() => {
    prisma = {
      operatorMembership: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(1),
        update: jest.fn(),
        delete: jest.fn(),
      },
      parkingOperator: {
        findUnique: jest.fn().mockResolvedValue({ status: OperatorStatus.VERIFIED }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({ role: UserRole.OPERATOR_ADMIN }),
        update: jest.fn(),
      },
      facilityManager: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      tariffPlanManager: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      auditLog: { create: jest.fn() },
      $executeRaw: jest.fn(),
      $transaction: jest.fn(async (cb: (t: typeof prisma) => unknown) => cb(prisma)),
    }
    const prismaService = prisma as unknown as PrismaService
    entitlements = { hasFeature: jest.fn().mockResolvedValue(true) }
    service = new OperatorMembersService(
      prismaService,
      new OperatorAccessService(prismaService, new OperatorScopeService(prismaService)),
      entitlements as unknown as EntitlementService,
    )
  })

  describe('list', () => {
    it('returns the operator’s members for one of its admins', async () => {
      withCallerMemberships([{ operatorId: 'op-a', role: OperatorMemberRole.ADMIN }])
      targetMembership(OperatorMemberRole.ADMIN)
      prisma.operatorMembership.findMany.mockResolvedValueOnce([
        { operatorId: 'op-a', role: OperatorMemberRole.ADMIN },
      ])
      prisma.operatorMembership.findMany.mockResolvedValueOnce([
        {
          userId: 'user-2',
          role: OperatorMemberRole.STAFF,
          scopes: ['org:booking.read', 'org:scan.execute'],
          createdAt: new Date('2026-02-01'),
          user: { email: 'member@biz.gr' },
        },
      ])

      await expect(service.list(operatorUser, 'op-a')).resolves.toEqual([
        {
          userId: 'user-2',
          email: 'member@biz.gr',
          role: OperatorMemberRole.STAFF,
          createdAt: new Date('2026-02-01'),
          // A staff member's set is exactly what is stored.
          scopes: ['org:booking.read', 'org:scan.execute'],
        },
      ])
    })

    it('refuses another tenant', async () => {
      withCallerMemberships([{ operatorId: 'op-a', role: OperatorMemberRole.ADMIN }])
      await expect(service.list(operatorUser, 'op-b')).rejects.toBeInstanceOf(OperatorNotFoundError)
    })

    it('refuses a consumer account (service-layer re-check)', async () => {
      await expect(service.list(consumerUser, 'op-a')).rejects.toBeInstanceOf(ForbiddenException)
      expect(prisma.operatorMembership.findMany).not.toHaveBeenCalled()
    })

    // The read half of the structural exclusion: a row written before the rule existed, or
    // by anything that bypassed the write path, still grants nothing.
    it('never reports org:billing.view for a staff member, even if the row holds it', async () => {
      withCallerMemberships([{ operatorId: 'op-a', role: OperatorMemberRole.ADMIN }])
      targetMembership(OperatorMemberRole.STAFF)
      prisma.operatorMembership.findMany.mockResolvedValueOnce([
        { operatorId: 'op-a', role: OperatorMemberRole.ADMIN },
      ])
      prisma.operatorMembership.findMany.mockResolvedValueOnce([
        {
          userId: 'user-2',
          role: OperatorMemberRole.STAFF,
          scopes: ['org:booking.read', 'org:billing.view'],
          createdAt: new Date('2026-02-01'),
          user: { email: 'member@biz.gr' },
        },
      ])

      const [member] = await service.list(operatorUser, 'op-a')
      expect(member!.scopes).toEqual(['org:booking.read'])
    })

    it('still derives org:billing.view for an admin', async () => {
      withCallerMemberships([{ operatorId: 'op-a', role: OperatorMemberRole.ADMIN }])
      targetMembership(OperatorMemberRole.ADMIN)
      prisma.operatorMembership.findMany.mockResolvedValueOnce([
        { operatorId: 'op-a', role: OperatorMemberRole.ADMIN },
      ])
      prisma.operatorMembership.findMany.mockResolvedValueOnce([
        {
          userId: 'user-2',
          role: OperatorMemberRole.ADMIN,
          scopes: [],
          createdAt: new Date('2026-02-01'),
          user: { email: 'owner@biz.gr' },
        },
      ])

      const [member] = await service.list(operatorUser, 'op-a')
      expect(member!.scopes).toContain('org:billing.view')
    })
  })

  describe('setScopes', () => {
    beforeEach(() => {
      withCallerMemberships([{ operatorId: 'op-a', role: OperatorMemberRole.ADMIN }])
      targetMembership(OperatorMemberRole.STAFF)
    })

    it('stores a customised set for an operator whose plan sells team management', async () => {
      await expect(
        service.setScopes(operatorUser, 'op-a', 'user-2', ['org:scan.execute']),
      ).resolves.toMatchObject({ scopes: ['org:scan.execute'] })

      // Third argument is the caller's transaction client: the plan is read under the same
      // operator lock the write takes, not before it.
      expect(entitlements.hasFeature).toHaveBeenCalledWith('op-a', 'team.management', prisma)
      expect(prisma.operatorMembership.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { scopes: ['org:scan.execute'] } }),
      )
    })

    it('refuses a customised set without the team.management feature', async () => {
      entitlements.hasFeature.mockResolvedValue(false)

      await expect(
        service.setScopes(operatorUser, 'op-a', 'user-2', ['org:scan.execute']),
      ).rejects.toBeInstanceOf(SubscriptionFeatureRequiredError)
      expect(prisma.operatorMembership.update).not.toHaveBeenCalled()
    })

    // The feature sells the right to DIFFER from the default, not the right to have staff.
    it('allows the default staff set without the feature', async () => {
      entitlements.hasFeature.mockResolvedValue(false)

      await expect(
        service.setScopes(operatorUser, 'op-a', 'user-2', [...DEFAULT_STAFF_SCOPES]),
      ).resolves.toMatchObject({ scopes: [...DEFAULT_STAFF_SCOPES].sort() })
    })

    it('rejects org:billing.view for a staff member however it arrives', async () => {
      await expect(
        service.setScopes(operatorUser, 'op-a', 'user-2', [
          'org:booking.read',
          'org:billing.view',
        ]),
      ).rejects.toBeInstanceOf(StaffScopeNotGrantableError)
      expect(prisma.operatorMembership.update).not.toHaveBeenCalled()
    })

    it('refuses to edit an admin’s derived set at all', async () => {
      targetMembership(OperatorMemberRole.ADMIN)

      await expect(
        service.setScopes(operatorUser, 'op-a', 'user-2', ['org:scan.execute']),
      ).rejects.toBeInstanceOf(AdminScopesNotEditableError)
    })

    // The derived-set invariant outranks the plan gate: an upgrade would not make this
    // request succeed, so reporting it as a missing feature would send the caller to buy one.
    it('reports an admin target as underivable even when the plan sells nothing', async () => {
      targetMembership(OperatorMemberRole.ADMIN)
      entitlements.hasFeature.mockResolvedValue(false)

      await expect(
        service.setScopes(operatorUser, 'op-a', 'user-2', ['org:scan.execute']),
      ).rejects.toBeInstanceOf(AdminScopesNotEditableError)
    })
  })

  describe('changeRole', () => {
    it('demotes a member, realigns their global role and moves the revocation watermark', async () => {
      withCallerMemberships([{ operatorId: 'op-a', role: OperatorMemberRole.ADMIN }])
      targetMembership(OperatorMemberRole.ADMIN)
      prisma.operatorMembership.count.mockResolvedValue(1)
      // After the demotion the target holds no ADMIN membership anywhere.
      prisma.operatorMembership.findMany.mockImplementation(
        ({ where }: { where: { userId: string; role?: OperatorMemberRole } }) => {
          if (where.userId === 'user-2') return [{ role: OperatorMemberRole.STAFF }]
          if (where.userId !== operatorUser.id) return []
          return where.role
            ? [{ operatorId: 'op-a', role: OperatorMemberRole.ADMIN }].filter(
                (m) => m.role === where.role,
              )
            : [{ operatorId: 'op-a', role: OperatorMemberRole.ADMIN }]
        },
      )

      const before = Date.now()
      await service.changeRole(operatorUser, 'op-a', 'user-2', OperatorMemberRole.STAFF)

      expect(prisma.operatorMembership.update).toHaveBeenCalledWith({
        where: { id: 'mem-2' },
        data: { role: OperatorMemberRole.STAFF },
      })

      const userUpdate = prisma.user.update.mock.calls[0]![0]
      expect(userUpdate.where).toEqual({ id: 'user-2' })
      expect(userUpdate.data.role).toBe(UserRole.OPERATOR_STAFF)
      // A live 15-minute access token would otherwise keep the admin rights it was minted
      // with; the watermark is what kills it now.
      expect(userUpdate.data.sessionsValidFrom.getTime()).toBeGreaterThanOrEqual(before)
    })

    it('refuses to demote the last admin of a verified operator, naming what breaks', async () => {
      withCallerMemberships([{ operatorId: 'op-a', role: OperatorMemberRole.ADMIN }])
      targetMembership(OperatorMemberRole.ADMIN)
      prisma.operatorMembership.count.mockResolvedValue(0)

      await expect(
        service.changeRole(operatorUser, 'op-a', 'user-2', OperatorMemberRole.STAFF),
      ).rejects.toThrow(/no administrator/)
      await expect(
        service.changeRole(operatorUser, 'op-a', 'user-2', OperatorMemberRole.STAFF),
      ).rejects.toBeInstanceOf(LastOperatorAdminError)

      expect(prisma.operatorMembership.update).not.toHaveBeenCalled()
      expect(prisma.user.update).not.toHaveBeenCalled()
      expect(prisma.auditLog.create).not.toHaveBeenCalled()
    })

    it('allows the last admin of a PENDING operator to be demoted', async () => {
      withCallerMemberships([{ operatorId: 'op-a', role: OperatorMemberRole.ADMIN }])
      targetMembership(OperatorMemberRole.ADMIN)
      prisma.parkingOperator.findUnique.mockResolvedValue({ status: OperatorStatus.PENDING })
      prisma.operatorMembership.count.mockResolvedValue(0)

      await expect(
        service.changeRole(operatorUser, 'op-a', 'user-2', OperatorMemberRole.STAFF),
      ).resolves.toMatchObject({ role: OperatorMemberRole.STAFF })
    })

    it('refuses self-demotion', async () => {
      withCallerMemberships([{ operatorId: 'op-a', role: OperatorMemberRole.ADMIN }])
      targetMembership(OperatorMemberRole.ADMIN, operatorUser.id)

      await expect(
        service.changeRole(operatorUser, 'op-a', operatorUser.id, OperatorMemberRole.STAFF),
      ).rejects.toBeInstanceOf(SelfRoleChangeError)
      expect(prisma.$transaction).not.toHaveBeenCalled()
    })

    it('refuses another tenant’s member', async () => {
      withCallerMemberships([{ operatorId: 'op-a', role: OperatorMemberRole.ADMIN }])
      targetMembership(OperatorMemberRole.STAFF)

      await expect(
        service.changeRole(operatorUser, 'op-b', 'user-2', OperatorMemberRole.ADMIN),
      ).rejects.toBeInstanceOf(OperatorNotFoundError)
      expect(prisma.$transaction).not.toHaveBeenCalled()
    })

    it('lets a multi-operator admin act on whichever of their operators the path names', async () => {
      withCallerMemberships([
        { operatorId: 'op-a', role: OperatorMemberRole.ADMIN },
        { operatorId: 'op-b', role: OperatorMemberRole.ADMIN },
      ])
      prisma.operatorMembership.findUnique.mockImplementation(
        ({ where }: { where: { operatorId_userId: { userId: string } } }) =>
          where.operatorId_userId.userId === operatorUser.id
            ? { id: 'mem-1', role: OperatorMemberRole.ADMIN }
            : {
                id: 'mem-2',
                role: OperatorMemberRole.STAFF,
                scopes: [],
            createdAt: new Date('2026-02-01'),
                user: { email: 'member@biz.gr' },
              },
      )

      await service.changeRole(operatorUser, 'op-b', 'user-2', OperatorMemberRole.ADMIN)

      expect(prisma.auditLog.create.mock.calls[0]![0].data.payload.operatorId).toBe('op-b')
    })

    it('refuses a caller who is only STAFF of the operator', async () => {
      withCallerMemberships([{ operatorId: 'op-a', role: OperatorMemberRole.STAFF }])
      prisma.operatorMembership.findUnique.mockResolvedValue({
        id: 'mem-1',
        role: OperatorMemberRole.STAFF,
      })

      await expect(
        service.changeRole(operatorUser, 'op-a', 'user-2', OperatorMemberRole.ADMIN),
      ).rejects.toBeInstanceOf(ForbiddenException)
    })

    it('throws OperatorMemberNotFoundError for a non-member', async () => {
      withCallerMemberships([{ operatorId: 'op-a', role: OperatorMemberRole.ADMIN }])
      targetMembership(OperatorMemberRole.ADMIN, 'someone-else')

      await expect(
        service.changeRole(operatorUser, 'op-a', 'user-2', OperatorMemberRole.STAFF),
      ).rejects.toBeInstanceOf(OperatorMemberNotFoundError)
    })

    it('writes one operator_member.role_changed audit row and no PII', async () => {
      withCallerMemberships([{ operatorId: 'op-a', role: OperatorMemberRole.ADMIN }])
      targetMembership(OperatorMemberRole.STAFF)

      await RequestContext.run({ ip: '203.0.113.11' }, () =>
        service.changeRole(operatorUser, 'op-a', 'user-2', OperatorMemberRole.ADMIN),
      )

      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1)
      const auditCall = prisma.auditLog.create.mock.calls[0]![0]
      expect(auditCall.data).toEqual({
        actorId: 'op-1',
        actorRole: 'operator_admin',
        action: 'operator_member.role_changed',
        entityType: 'OperatorMembership',
        entityId: 'mem-2',
        payload: {
          operatorId: 'op-a',
          userId: 'user-2',
          from: OperatorMemberRole.STAFF,
          to: OperatorMemberRole.ADMIN,
        },
        ipAddress: '203.0.113.11',
      })
      expect(JSON.stringify(auditCall.data)).not.toContain('member@biz.gr')
    })

    it('writes nothing when the role is already what was asked for', async () => {
      withCallerMemberships([{ operatorId: 'op-a', role: OperatorMemberRole.ADMIN }])
      targetMembership(OperatorMemberRole.STAFF)

      await service.changeRole(operatorUser, 'op-a', 'user-2', OperatorMemberRole.STAFF)

      expect(prisma.operatorMembership.update).not.toHaveBeenCalled()
      expect(prisma.user.update).not.toHaveBeenCalled()
      expect(prisma.auditLog.create).not.toHaveBeenCalled()
    })

    it('never downgrades a platform admin’s global role', async () => {
      withCallerMemberships([{ operatorId: 'op-a', role: OperatorMemberRole.ADMIN }])
      targetMembership(OperatorMemberRole.ADMIN)
      prisma.user.findUnique.mockResolvedValue({ role: UserRole.PLATFORM_ADMIN })

      await service.changeRole(operatorUser, 'op-a', 'user-2', OperatorMemberRole.STAFF)

      const userUpdate = prisma.user.update.mock.calls[0]![0]
      expect(userUpdate.data).not.toHaveProperty('role')
      expect(userUpdate.data.sessionsValidFrom).toBeInstanceOf(Date)
    })

    it('serializes concurrent membership writes on the operator row', async () => {
      withCallerMemberships([{ operatorId: 'op-a', role: OperatorMemberRole.ADMIN }])
      targetMembership(OperatorMemberRole.STAFF)

      await service.changeRole(operatorUser, 'op-a', 'user-2', OperatorMemberRole.ADMIN)

      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1)
      expect(prisma.$executeRaw.mock.calls[0]![1]).toBe('op-a')
    })
  })

  describe('remove', () => {
    it('deletes the membership, realigns the global role and revokes sessions', async () => {
      withCallerMemberships([{ operatorId: 'op-a', role: OperatorMemberRole.ADMIN }])
      targetMembership(OperatorMemberRole.STAFF)
      prisma.operatorMembership.findMany.mockImplementation(
        ({ where }: { where: { userId: string; role?: OperatorMemberRole } }) => {
          if (where.userId === 'user-2') return []
          if (where.userId !== operatorUser.id) return []
          return [{ operatorId: 'op-a', role: OperatorMemberRole.ADMIN }].filter(
            (m) => !where.role || m.role === where.role,
          )
        },
      )

      await expect(service.remove(operatorUser, 'op-a', 'user-2')).resolves.toBeUndefined()

      expect(prisma.operatorMembership.delete).toHaveBeenCalledWith({ where: { id: 'mem-2' } })
      const userUpdate = prisma.user.update.mock.calls[0]![0]
      expect(userUpdate.data.role).toBe(UserRole.USER)
      expect(userUpdate.data.sessionsValidFrom).toBeInstanceOf(Date)
    })

    it('refuses to remove the last admin of a verified operator', async () => {
      withCallerMemberships([{ operatorId: 'op-a', role: OperatorMemberRole.ADMIN }])
      targetMembership(OperatorMemberRole.ADMIN)
      prisma.operatorMembership.count.mockResolvedValue(0)

      await expect(service.remove(operatorUser, 'op-a', 'user-2')).rejects.toBeInstanceOf(
        LastOperatorAdminError,
      )
      expect(prisma.operatorMembership.delete).not.toHaveBeenCalled()
      expect(prisma.auditLog.create).not.toHaveBeenCalled()
    })

    it('refuses self-removal', async () => {
      withCallerMemberships([{ operatorId: 'op-a', role: OperatorMemberRole.ADMIN }])
      targetMembership(OperatorMemberRole.ADMIN, operatorUser.id)

      await expect(service.remove(operatorUser, 'op-a', operatorUser.id)).rejects.toBeInstanceOf(
        SelfMembershipRemovalError,
      )
      expect(prisma.$transaction).not.toHaveBeenCalled()
    })

    it('refuses another tenant’s member', async () => {
      withCallerMemberships([{ operatorId: 'op-a', role: OperatorMemberRole.ADMIN }])

      await expect(service.remove(operatorUser, 'op-b', 'user-2')).rejects.toBeInstanceOf(
        OperatorNotFoundError,
      )
      expect(prisma.$transaction).not.toHaveBeenCalled()
    })

    it('lets a platform admin act on any operator and audits it', async () => {
      targetMembership(OperatorMemberRole.STAFF)

      await service.remove(platformUser, 'op-z', 'user-2')

      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: {
          actorId: 'admin-1',
          actorRole: 'platform_admin',
          action: 'operator_member.removed',
          entityType: 'OperatorMembership',
          entityId: 'mem-2',
          payload: {
            operatorId: 'op-z',
            userId: 'user-2',
            role: OperatorMemberRole.STAFF,
            facilitiesRevoked: 0,
            tariffPlansRevoked: 0,
          },
          ipAddress: null,
        },
      })
    })

    it('revokes the removed member’s assignments for that operator only', async () => {
      withCallerMemberships([{ operatorId: 'op-a', role: OperatorMemberRole.ADMIN }])
      targetMembership(OperatorMemberRole.STAFF)
      prisma.facilityManager.deleteMany.mockResolvedValue({ count: 3 })
      prisma.tariffPlanManager.deleteMany.mockResolvedValue({ count: 1 })

      await service.remove(operatorUser, 'op-a', 'user-2')

      expect(prisma.facilityManager.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user-2', facility: { operatorId: 'op-a' } },
      })
      expect(prisma.tariffPlanManager.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user-2', tariffPlan: { operatorId: 'op-a' } },
      })
      expect(prisma.auditLog.create.mock.calls[0]![0].data.payload).toMatchObject({
        facilitiesRevoked: 3,
        tariffPlansRevoked: 1,
      })
    })

    it('revokes inside the same transaction as the membership delete', async () => {
      withCallerMemberships([{ operatorId: 'op-a', role: OperatorMemberRole.ADMIN }])
      targetMembership(OperatorMemberRole.STAFF)

      await service.remove(operatorUser, 'op-a', 'user-2')

      // The mock $transaction passes the same client through, so proving they ran at all is
      // proving they ran on the transaction client — a revoke outside it could leave the
      // member with working access after a rolled-back removal.
      expect(prisma.$transaction).toHaveBeenCalledTimes(1)
      expect(prisma.facilityManager.deleteMany).toHaveBeenCalledTimes(1)
      expect(prisma.tariffPlanManager.deleteMany).toHaveBeenCalledTimes(1)
    })

    it('leaves assignments alone when the removal is refused', async () => {
      withCallerMemberships([{ operatorId: 'op-a', role: OperatorMemberRole.ADMIN }])
      targetMembership(OperatorMemberRole.ADMIN)
      prisma.operatorMembership.count.mockResolvedValue(0)

      await expect(service.remove(operatorUser, 'op-a', 'user-2')).rejects.toBeInstanceOf(
        LastOperatorAdminError,
      )
      expect(prisma.facilityManager.deleteMany).not.toHaveBeenCalled()
      expect(prisma.tariffPlanManager.deleteMany).not.toHaveBeenCalled()
    })

    it('does not revoke on a role change — only leaving the operator does', async () => {
      withCallerMemberships([{ operatorId: 'op-a', role: OperatorMemberRole.ADMIN }])
      targetMembership(OperatorMemberRole.STAFF)

      await service.changeRole(operatorUser, 'op-a', 'user-2', OperatorMemberRole.ADMIN)

      expect(prisma.facilityManager.deleteMany).not.toHaveBeenCalled()
      expect(prisma.tariffPlanManager.deleteMany).not.toHaveBeenCalled()
    })

    it('throws OperatorMemberNotFoundError for a non-member', async () => {
      withCallerMemberships([{ operatorId: 'op-a', role: OperatorMemberRole.ADMIN }])
      targetMembership(OperatorMemberRole.STAFF, 'someone-else')

      await expect(service.remove(operatorUser, 'op-a', 'user-2')).rejects.toBeInstanceOf(
        OperatorMemberNotFoundError,
      )
    })
  })

  describe('OperatorAccessService.resolveAdministrable', () => {
    let access: OperatorAccessService

    beforeEach(() => {
      const prismaService = prisma as unknown as PrismaService
      access = new OperatorAccessService(prismaService, new OperatorScopeService(prismaService))
    })

    it('infers the single operator of a caller who names none', async () => {
      withCallerMemberships([{ operatorId: 'op-a', role: OperatorMemberRole.ADMIN }])
      prisma.operatorMembership.findUnique.mockResolvedValue({ role: OperatorMemberRole.ADMIN })

      await expect(access.resolveAdministrable(operatorUser, undefined)).resolves.toBe('op-a')
    })

    it('infers nothing for a multi-operator caller who names none', async () => {
      withCallerMemberships([
        { operatorId: 'op-a', role: OperatorMemberRole.ADMIN },
        { operatorId: 'op-b', role: OperatorMemberRole.ADMIN },
      ])

      await expect(access.resolveAdministrable(operatorUser, undefined)).rejects.toBeInstanceOf(
        OperatorTargetRequiredError,
      )
    })

    it('makes a platform caller name one', async () => {
      await expect(access.resolveAdministrable(platformUser, undefined)).rejects.toThrow(
        'operatorId required',
      )
      await expect(access.resolveAdministrable(platformUser, 'op-z')).resolves.toBe('op-z')
    })

    it('lists only the operators the caller admins', async () => {
      withCallerMemberships([
        { operatorId: 'op-a', role: OperatorMemberRole.ADMIN },
        { operatorId: 'op-b', role: OperatorMemberRole.STAFF },
      ])

      await expect(access.administrableOperatorIds(operatorUser)).resolves.toEqual(['op-a'])
      await expect(access.administrableOperatorIds(platformUser)).resolves.toBeNull()
    })
  })
})
