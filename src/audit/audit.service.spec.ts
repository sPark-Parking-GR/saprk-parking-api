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

const baseQuery: ListAuditLogDto = { skip: 0, take: 20 }

describe('AuditService', () => {
  let prisma: {
    auditLog: { findMany: jest.Mock; count: jest.Mock }
    user: { findMany: jest.Mock }
  }
  let service: AuditService

  beforeEach(() => {
    prisma = {
      auditLog: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      user: { findMany: jest.fn().mockResolvedValue([]) },
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
})
