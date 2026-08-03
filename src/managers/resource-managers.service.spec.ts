import { ForbiddenException } from '@nestjs/common'
import { LifecycleStatus, OperatorMemberRole, UserRole } from '@prisma/client'
import type { AuthUser } from '@spark/types'
import { OperatorScopeService } from '../common/authz/operator-scope.service'
import {
  FacilityHasNoOperatorError,
  FacilityNotFoundError,
  ManagerAssignmentRejectedError,
  TariffPlanNotFoundError,
} from '../common/errors/domain.errors'
import { OperatorAccessService } from '../operators/operator-access.service'
import { OperatorNotFoundError } from '../operators/operators.types'
import type { PrismaService } from '../prisma/prisma.service'
import { ResourceManagersService } from './resource-managers.service'

const operatorAdmin: AuthUser = {
  id: 'u-admin',
  email: 'admin@biz.gr',
  role: 'operator_admin',
  emailVerified: true,
}

const operatorStaff: AuthUser = {
  id: 'u-staff',
  email: 'staff@biz.gr',
  role: 'operator_staff',
  emailVerified: true,
}

const platformAdmin: AuthUser = {
  id: 'u-platform',
  email: 'pa@spark.gr',
  role: 'platform_admin',
  emailVerified: true,
}

/** A member row as the service selects it. */
function member(
  userId: string,
  over: {
    memberRole?: OperatorMemberRole
    userRole?: UserRole
    lifecycleStatus?: LifecycleStatus
    deletedAt?: Date | null
  } = {},
) {
  return {
    userId,
    role: over.memberRole ?? OperatorMemberRole.STAFF,
    user: {
      email: `${userId}@biz.gr`,
      displayName: null,
      role: over.userRole ?? UserRole.OPERATOR_STAFF,
      lifecycleStatus: over.lifecycleStatus ?? LifecycleStatus.ACTIVE,
      deletedAt: over.deletedAt ?? null,
    },
  }
}

describe('ResourceManagersService', () => {
  let prisma: {
    facility: { findFirst: jest.Mock }
    tariffPlan: { findFirst: jest.Mock }
    operatorMembership: { findMany: jest.Mock; findUnique: jest.Mock }
    facilityManager: { findMany: jest.Mock; createMany: jest.Mock; deleteMany: jest.Mock }
    tariffPlanManager: { findMany: jest.Mock; createMany: jest.Mock; deleteMany: jest.Mock }
    auditLog: { create: jest.Mock }
    $transaction: jest.Mock
  }
  let service: ResourceManagersService

  /** The caller's own memberships, which drive scope resolution and the ADMIN check. */
  function callerMemberships(rows: { operatorId: string; role: OperatorMemberRole }[]): void {
    prisma.operatorMembership.findMany.mockImplementation(
      ({ where }: { where: { userId?: string; operatorId?: string } }) => {
        if (where.userId) return rows.map((r) => ({ operatorId: r.operatorId, role: r.role }))
        return operatorMembers
      },
    )
    prisma.operatorMembership.findUnique.mockImplementation(
      ({ where }: { where: { operatorId_userId: { operatorId: string } } }) => {
        const match = rows.find((r) => r.operatorId === where.operatorId_userId.operatorId)
        return match ? { role: match.role } : null
      },
    )
  }

  let operatorMembers: ReturnType<typeof member>[]

  beforeEach(() => {
    operatorMembers = [
      member(operatorAdmin.id, {
        memberRole: OperatorMemberRole.ADMIN,
        userRole: UserRole.OPERATOR_ADMIN,
      }),
      member(operatorStaff.id),
    ]
    prisma = {
      facility: { findFirst: jest.fn().mockResolvedValue({ operatorId: 'op1' }) },
      tariffPlan: { findFirst: jest.fn().mockResolvedValue({ operatorId: 'op1' }) },
      operatorMembership: { findMany: jest.fn(), findUnique: jest.fn() },
      facilityManager: {
        findMany: jest.fn().mockResolvedValue([]),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      tariffPlanManager: {
        findMany: jest.fn().mockResolvedValue([]),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      auditLog: { create: jest.fn() },
      $transaction: jest.fn(async (cb: (t: typeof prisma) => unknown) => cb(prisma)),
    }
    const prismaService = prisma as unknown as PrismaService
    const scope = new OperatorScopeService(prismaService)
    service = new ResourceManagersService(
      prismaService,
      scope,
      new OperatorAccessService(prismaService, scope),
    )
    callerMemberships([{ operatorId: 'op1', role: OperatorMemberRole.ADMIN }])
  })

  describe('reads', () => {
    it('returns current managers alongside the operator’s eligible candidates', async () => {
      const assignedAt = new Date('2026-08-01T10:00:00Z')
      prisma.facilityManager.findMany.mockResolvedValue([
        {
          userId: operatorStaff.id,
          assignedAt,
          assignedBy: operatorAdmin.id,
          user: { email: 'staff@biz.gr', displayName: 'Staffer' },
        },
      ])

      const res = await service.listFacilityManagers(operatorAdmin, 'f1')

      expect(res).toEqual({
        resourceId: 'f1',
        operatorId: 'op1',
        managers: [
          {
            userId: operatorStaff.id,
            email: 'staff@biz.gr',
            displayName: 'Staffer',
            memberRole: OperatorMemberRole.STAFF,
            assignedAt,
            assignedBy: operatorAdmin.id,
          },
        ],
        candidates: [
          {
            userId: operatorAdmin.id,
            email: `${operatorAdmin.id}@biz.gr`,
            displayName: null,
            memberRole: OperatorMemberRole.ADMIN,
          },
          {
            userId: operatorStaff.id,
            email: `${operatorStaff.id}@biz.gr`,
            displayName: null,
            memberRole: OperatorMemberRole.STAFF,
          },
        ],
      })
    })

    it('offers no platform admin, archived or tombstoned member as a candidate', async () => {
      operatorMembers = [
        member('u-pa-member', { userRole: UserRole.PLATFORM_ADMIN }),
        member('u-consumer', { userRole: UserRole.USER }),
        member('u-archived', { lifecycleStatus: LifecycleStatus.ARCHIVED }),
        member('u-tombstone', { deletedAt: new Date() }),
        member('u-ok'),
      ]

      const res = await service.listFacilityManagers(operatorAdmin, 'f1')

      expect(res.candidates.map((c) => c.userId)).toEqual(['u-ok'])
    })

    // The manager list is a resource read like any other: a foreign id must be
    // indistinguishable from a fabricated one.
    it('answers not-found for a resource outside the caller’s operator scope', async () => {
      prisma.facility.findFirst.mockResolvedValue(null)

      await expect(service.listFacilityManagers(operatorAdmin, 'f-other')).rejects.toBeInstanceOf(
        FacilityNotFoundError,
      )
      expect(prisma.facility.findFirst.mock.calls[0]![0].where).toEqual({
        id: 'f-other',
        operatorId: { in: ['op1'] },
      })
    })

    it('refuses managers for an operator-less facility, even for a platform admin', async () => {
      prisma.facility.findFirst.mockResolvedValue({ operatorId: null })

      await expect(service.listFacilityManagers(platformAdmin, 'f-unassigned')).rejects.toBeInstanceOf(
        FacilityHasNoOperatorError,
      )
    })

    it('answers not-found for a foreign tariff plan', async () => {
      prisma.tariffPlan.findFirst.mockResolvedValue(null)

      await expect(service.listTariffPlanManagers(operatorAdmin, 'p-other')).rejects.toBeInstanceOf(
        TariffPlanNotFoundError,
      )
    })

    // Deliberately NOT narrowed by the assignment it administers — otherwise a resource
    // nobody manages yet could never be granted to anyone.
    it('does not require the caller to manage the resource themselves', async () => {
      prisma.facilityManager.findMany.mockResolvedValue([])

      await expect(service.listFacilityManagers(operatorAdmin, 'f1')).resolves.toMatchObject({
        managers: [],
      })
      expect(prisma.facility.findFirst.mock.calls[0]![0].where.managers).toBeUndefined()
    })
  })

  describe('authorization', () => {
    it('refuses operator_staff even before tenancy is considered', async () => {
      await expect(service.replaceFacilityManagers(operatorStaff, 'f1', [])).rejects.toBeInstanceOf(
        ForbiddenException,
      )
      expect(prisma.$transaction).not.toHaveBeenCalled()
    })

    it('refuses an operator admin who is only STAFF in the owning operator', async () => {
      callerMemberships([{ operatorId: 'op1', role: OperatorMemberRole.STAFF }])

      await expect(service.replaceFacilityManagers(operatorAdmin, 'f1', [])).rejects.toBeInstanceOf(
        ForbiddenException,
      )
    })

    it('refuses with not-found when the resource belongs to another tenant', async () => {
      prisma.facility.findFirst.mockResolvedValue({ operatorId: 'op-other' })

      await expect(service.replaceFacilityManagers(operatorAdmin, 'f1', [])).rejects.toBeInstanceOf(
        OperatorNotFoundError,
      )
    })

    it('lets a platform admin administer any operator', async () => {
      callerMemberships([])

      await expect(
        service.replaceFacilityManagers(platformAdmin, 'f1', [operatorStaff.id]),
      ).resolves.toBeDefined()
      expect(prisma.facilityManager.createMany).toHaveBeenCalled()
    })
  })

  describe('assignee validation', () => {
    it('rejects the whole request when any id is not a member of the owning operator', async () => {
      await expect(
        service.replaceFacilityManagers(operatorAdmin, 'f1', [operatorStaff.id, 'u-outsider']),
      ).rejects.toBeInstanceOf(ManagerAssignmentRejectedError)
      expect(prisma.facilityManager.createMany).not.toHaveBeenCalled()
      expect(prisma.facilityManager.deleteMany).not.toHaveBeenCalled()
      expect(prisma.auditLog.create).not.toHaveBeenCalled()
    })

    it('names the offending ids rather than silently dropping them', async () => {
      await expect(
        service.replaceFacilityManagers(operatorAdmin, 'f1', ['u-outsider']),
      ).rejects.toThrow(/u-outsider/)
    })

    it('rejects a platform admin as an assignee, even though they are a member', async () => {
      operatorMembers = [
        ...operatorMembers,
        member('u-pa-member', { userRole: UserRole.PLATFORM_ADMIN }),
      ]

      await expect(
        service.replaceFacilityManagers(operatorAdmin, 'f1', ['u-pa-member']),
      ).rejects.toThrow(/platform admins and consumer accounts/)
    })

    it('rejects a consumer account as an assignee', async () => {
      operatorMembers = [...operatorMembers, member('u-consumer', { userRole: UserRole.USER })]

      await expect(
        service.replaceFacilityManagers(operatorAdmin, 'f1', ['u-consumer']),
      ).rejects.toBeInstanceOf(ManagerAssignmentRejectedError)
    })

    it('rejects a tariff-plan assignee from another tenant the same way', async () => {
      await expect(
        service.replaceTariffPlanManagers(operatorAdmin, 'p1', ['u-outsider']),
      ).rejects.toBeInstanceOf(ManagerAssignmentRejectedError)
      expect(prisma.tariffPlanManager.createMany).not.toHaveBeenCalled()
    })
  })

  describe('replace semantics', () => {
    it('applies the set difference and audits exactly what changed', async () => {
      prisma.facilityManager.findMany.mockResolvedValueOnce([
        { userId: operatorStaff.id },
        { userId: 'u-gone' },
      ])
      operatorMembers = [...operatorMembers, member('u-gone')]

      await service.replaceFacilityManagers(operatorAdmin, 'f1', [
        operatorStaff.id,
        operatorAdmin.id,
      ])

      expect(prisma.facilityManager.deleteMany).toHaveBeenCalledWith({
        where: { facilityId: 'f1', userId: { in: ['u-gone'] } },
      })
      expect(prisma.facilityManager.createMany).toHaveBeenCalledWith({
        data: [{ facilityId: 'f1', userId: operatorAdmin.id, assignedBy: operatorAdmin.id }],
      })
      expect(prisma.auditLog.create.mock.calls[0]![0].data).toMatchObject({
        action: 'facility.managers_changed',
        entityType: 'Facility',
        entityId: 'f1',
        payload: { added: [operatorAdmin.id], removed: ['u-gone'] },
      })
    })

    it('is idempotent: resubmitting the same set writes nothing', async () => {
      prisma.facilityManager.findMany.mockResolvedValueOnce([{ userId: operatorStaff.id }])

      await service.replaceFacilityManagers(operatorAdmin, 'f1', [operatorStaff.id])

      expect(prisma.facilityManager.deleteMany).not.toHaveBeenCalled()
      expect(prisma.facilityManager.createMany).not.toHaveBeenCalled()
      expect(prisma.auditLog.create.mock.calls[0]![0].data.payload).toEqual({
        added: [],
        removed: [],
      })
    })

    it('collapses duplicate ids instead of attempting two rows for one person', async () => {
      await service.replaceFacilityManagers(operatorAdmin, 'f1', [
        operatorStaff.id,
        operatorStaff.id,
      ])

      expect(prisma.facilityManager.createMany).toHaveBeenCalledWith({
        data: [{ facilityId: 'f1', userId: operatorStaff.id, assignedBy: operatorAdmin.id }],
      })
    })

    it('an empty set clears every manager', async () => {
      prisma.facilityManager.findMany.mockResolvedValueOnce([{ userId: operatorStaff.id }])

      await service.replaceFacilityManagers(operatorAdmin, 'f1', [])

      expect(prisma.facilityManager.deleteMany).toHaveBeenCalledWith({
        where: { facilityId: 'f1', userId: { in: [operatorStaff.id] } },
      })
      expect(prisma.facilityManager.createMany).not.toHaveBeenCalled()
    })

    // The accepted trade-off: within their own tenant an operator admin is not constrained
    // by the restriction, because they can always grant themselves.
    it('lets an operator admin add themselves to a resource nobody manages', async () => {
      await service.replaceFacilityManagers(operatorAdmin, 'f1', [operatorAdmin.id])

      expect(prisma.facilityManager.createMany).toHaveBeenCalledWith({
        data: [{ facilityId: 'f1', userId: operatorAdmin.id, assignedBy: operatorAdmin.id }],
      })
    })

    it('writes tariff-plan assignments against the plan id column', async () => {
      await service.replaceTariffPlanManagers(operatorAdmin, 'p1', [operatorStaff.id])

      expect(prisma.tariffPlanManager.createMany).toHaveBeenCalledWith({
        data: [{ tariffPlanId: 'p1', userId: operatorStaff.id, assignedBy: operatorAdmin.id }],
      })
      expect(prisma.auditLog.create.mock.calls[0]![0].data).toMatchObject({
        action: 'tariff_plan.managers_changed',
        entityType: 'TariffPlan',
      })
    })
  })
})
