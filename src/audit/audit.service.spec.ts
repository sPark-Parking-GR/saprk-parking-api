import { ForbiddenException } from '@nestjs/common'
import type { AuthUser } from '@spark/types'
import type { PrismaService } from '../prisma/prisma.service'
import { AuditService } from './audit.service'
import type { ListAuditLogDto } from './dto/audit.dto'

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

const superAdminUser: AuthUser = {
  id: 'super-1',
  email: 'root@spark.gr',
  role: 'super_admin',
  emailVerified: true,
}

const baseQuery: ListAuditLogDto = { skip: 0, take: 20 }

describe('AuditService', () => {
  let prisma: {
    auditLog: { findMany: jest.Mock; count: jest.Mock }
    user: { findMany: jest.Mock }
    parkingOperator: { findMany: jest.Mock }
    facility: { findMany: jest.Mock }
    tariffPlan: { findMany: jest.Mock }
  }
  let service: AuditService

  beforeEach(() => {
    prisma = {
      auditLog: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      user: { findMany: jest.fn().mockResolvedValue([]) },
      parkingOperator: { findMany: jest.fn().mockResolvedValue([]) },
      facility: { findMany: jest.fn().mockResolvedValue([]) },
      tariffPlan: { findMany: jest.fn().mockResolvedValue([]) },
    }
    service = new AuditService(prisma as unknown as PrismaService)
  })

  it('rejects a non-platform-admin actor (service-layer re-check)', async () => {
    await expect(service.list(operatorUser, baseQuery)).rejects.toBeInstanceOf(ForbiddenException)
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled()
  })

  it('lists with no filters beyond pagination when none are given', async () => {
    await service.list(platformUser, baseQuery)

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          actorId: undefined,
          action: undefined,
          entityType: undefined,
          entityId: undefined,
          createdAt: undefined,
        },
      }),
    )
  })

  it('narrows by actorId alone', async () => {
    await service.list(platformUser, { ...baseQuery, actorId: 'user-9' })

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ actorId: 'user-9' }) }),
    )
    expect(prisma.auditLog.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ actorId: 'user-9' }),
    })
  })

  it('narrows by action alone', async () => {
    await service.list(platformUser, { ...baseQuery, action: 'invite.revoked' })

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ action: 'invite.revoked' }) }),
    )
  })

  it('narrows by entityType and entityId together', async () => {
    await service.list(platformUser, {
      ...baseQuery,
      entityType: 'ParkingOperator',
      entityId: 'op-1',
    })

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ entityType: 'ParkingOperator', entityId: 'op-1' }),
      }),
    )
  })

  it('narrows by a createdAt range', async () => {
    const createdFrom = new Date('2026-01-01T00:00:00.000Z')
    const createdTo = new Date('2026-01-31T00:00:00.000Z')

    await service.list(platformUser, { ...baseQuery, createdFrom, createdTo })

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ createdAt: { gte: createdFrom, lte: createdTo } }),
      }),
    )
  })

  it('composes every filter together in one query', async () => {
    const createdFrom = new Date('2026-01-01T00:00:00.000Z')
    const createdTo = new Date('2026-01-31T00:00:00.000Z')

    await service.list(platformUser, {
      ...baseQuery,
      actorId: 'user-9',
      action: 'invite.revoked',
      entityType: 'OperatorInvite',
      entityId: 'inv-1',
      createdFrom,
      createdTo,
    })

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          actorId: 'user-9',
          action: 'invite.revoked',
          entityType: 'OperatorInvite',
          entityId: 'inv-1',
          createdAt: { gte: createdFrom, lte: createdTo },
        },
      }),
    )
  })

  it('resolves actorQuery to matching user ids and filters by them', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 'u-1' }, { id: 'u-2' }])

    await service.list(platformUser, { ...baseQuery, actorQuery: 'jane' })

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { email: { contains: 'jane', mode: 'insensitive' } },
            { displayName: { contains: 'jane', mode: 'insensitive' } },
          ],
        }),
      }),
    )
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ actorId: { in: ['u-1', 'u-2'] } }) }),
    )
  })

  it('excludes every row when actorQuery matches nobody, rather than ignoring the filter', async () => {
    prisma.user.findMany.mockResolvedValue([])

    await service.list(platformUser, { ...baseQuery, actorQuery: 'nobody' })

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ actorId: { in: [] } }) }),
    )
  })

  it('resolves entityLabel for ParkingOperator, Facility and TariffPlan rows', async () => {
    prisma.auditLog.findMany.mockResolvedValue([
      {
        id: 'a1',
        actorId: null,
        actorRole: null,
        action: 'operator.archived',
        entityType: 'ParkingOperator',
        entityId: 'op-1',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        id: 'a2',
        actorId: null,
        actorRole: null,
        action: 'facility.archived',
        entityType: 'Facility',
        entityId: 'fac-1',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        id: 'a3',
        actorId: null,
        actorRole: null,
        action: 'tariff_plan.archived',
        entityType: 'TariffPlan',
        entityId: 'tp-1',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ])
    prisma.parkingOperator.findMany.mockResolvedValue([{ id: 'op-1', name: 'Athens Parking Co' }])
    prisma.facility.findMany.mockResolvedValue([{ id: 'fac-1', name: 'Syntagma Garage' }])
    prisma.tariffPlan.findMany.mockResolvedValue([{ id: 'tp-1', name: 'Standard' }])

    const result = await service.list(platformUser, baseQuery)

    expect(result.items[0]!.entityLabel).toBe('Athens Parking Co')
    expect(result.items[1]!.entityLabel).toBe('Syntagma Garage')
    expect(result.items[2]!.entityLabel).toBe('Standard')
  })

  it('opts out of the lifecycle extension default filter so an archived resource still resolves a name', async () => {
    // Regression coverage: the lifecycle extension silently narrows every unqualified
    // query on these models to lifecycleStatus ACTIVE, which would make an archived or
    // tombstoned subject resolve to null even though its row still exists.
    prisma.auditLog.findMany.mockResolvedValue([
      {
        id: 'a1',
        actorId: null,
        actorRole: null,
        action: 'tariff_plan.archived',
        entityType: 'TariffPlan',
        entityId: 'tp-1',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ])
    prisma.tariffPlan.findMany.mockResolvedValue([{ id: 'tp-1', name: 'Standard' }])

    await service.list(platformUser, baseQuery)

    expect(prisma.tariffPlan.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          lifecycleStatus: { in: ['ACTIVE', 'ARCHIVED', 'TOMBSTONED', 'PURGED'] },
        }),
      }),
    )
  })

  it('falls back to a null entityLabel when the resource no longer exists, and still returns the row', async () => {
    prisma.auditLog.findMany.mockResolvedValue([
      {
        id: 'a1',
        actorId: null,
        actorRole: null,
        action: 'operator.purged',
        entityType: 'ParkingOperator',
        entityId: 'gone',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ])
    prisma.parkingOperator.findMany.mockResolvedValue([])

    const result = await service.list(platformUser, baseQuery)

    expect(result.items).toHaveLength(1)
    expect(result.items[0]!.entityLabel).toBeNull()
    expect(result.items[0]!.entityId).toBe('gone')
  })

  it('resolves a User entityLabel for an actor holding identity:user.read', async () => {
    prisma.auditLog.findMany.mockResolvedValue([
      {
        id: 'a1',
        actorId: null,
        actorRole: null,
        action: 'user.archived',
        entityType: 'User',
        entityId: 'u-1',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ])
    prisma.user.findMany.mockResolvedValue([
      { id: 'u-1', displayName: 'Jane Doe', email: 'jane@spark.gr' },
    ])

    const result = await service.list(superAdminUser, baseQuery)

    expect(result.items[0]!.entityLabel).toBe('Jane Doe')
  })

  it('withholds the User entityLabel from a platform admin lacking identity:user.read', async () => {
    prisma.auditLog.findMany.mockResolvedValue([
      {
        id: 'a1',
        actorId: null,
        actorRole: null,
        action: 'user.archived',
        entityType: 'User',
        entityId: 'u-1',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ])

    const result = await service.list(platformUser, baseQuery)

    expect(result.items[0]!.entityLabel).toBeNull()
    expect(prisma.user.findMany).not.toHaveBeenCalled()
  })
})
