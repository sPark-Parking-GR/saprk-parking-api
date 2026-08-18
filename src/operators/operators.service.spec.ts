import { ForbiddenException } from '@nestjs/common'
import { OperatorStatus } from '@prisma/client'
import { ORG_PERMISSIONS, type AuthUser } from '@spark/types'
import { RequestContext } from '../common/context/request-context'
import { UNCLAIMED_OPERATOR_ID } from '../ingestion/ingestion.constants'
import type { PrismaService } from '../prisma/prisma.service'
import { OperatorsService } from './operators.service'
import {
  OperatorNotFoundError,
  OperatorNotReactivatableError,
  OperatorNotSuspendableError,
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

describe('OperatorsService', () => {
  let prisma: {
    parkingOperator: {
      findMany: jest.Mock
      findUnique: jest.Mock
      updateMany: jest.Mock
    }
    auditLog: { create: jest.Mock }
    $transaction: jest.Mock
  }
  let service: OperatorsService

  beforeEach(() => {
    prisma = {
      parkingOperator: { findMany: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn() },
      auditLog: { create: jest.fn() },
      $transaction: jest.fn(async (cb: (tx: typeof prisma) => unknown) => cb(prisma)),
    }
    service = new OperatorsService(prisma as unknown as PrismaService)
  })

  describe('list', () => {
    it('maps counts and excludes the synthetic ingestion operator', async () => {
      prisma.parkingOperator.findMany.mockResolvedValue([
        {
          id: 'op-a',
          name: 'Biz A',
          status: OperatorStatus.VERIFIED,
          createdAt: new Date('2026-01-02'),
          _count: { facilities: 1, memberships: 2 },
        },
      ])

      const result = await service.list(platformUser)

      expect(prisma.parkingOperator.findMany).toHaveBeenCalledWith({
        where: { id: { not: UNCLAIMED_OPERATOR_ID } },
        orderBy: { createdAt: 'desc' },
        include: { _count: { select: { facilities: true, memberships: true } } },
      })
      expect(result).toEqual([
        {
          id: 'op-a',
          name: 'Biz A',
          status: OperatorStatus.VERIFIED,
          facilityCount: 1,
          memberCount: 2,
          createdAt: new Date('2026-01-02'),
        },
      ])
    })

    it('rejects a non-platform-admin actor (service-layer re-check)', async () => {
      await expect(service.list(operatorUser)).rejects.toBeInstanceOf(ForbiddenException)
      expect(prisma.parkingOperator.findMany).not.toHaveBeenCalled()
    })
  })

  describe('getDetail', () => {
    it('maps operator, facilities, plans and members into one detail object', async () => {
      prisma.parkingOperator.findUnique.mockResolvedValue({
        id: 'op-a',
        name: 'Biz A',
        status: OperatorStatus.VERIFIED,
        createdAt: new Date('2026-01-02'),
        facilities: [
          {
            id: 'f-1',
            name: 'Lot 1',
            address: 'Odos 1',
            isActive: true,
            isVerified: true,
            kind: 'BUSINESS',
          },
        ],
        tariffPlans: [{ id: 'p-1', name: 'Standard', isActive: true, isDefault: true }],
        memberships: [
          {
            userId: 'u-1',
            role: 'ADMIN',
            scopes: [],
            createdAt: new Date('2026-01-03'),
            user: { email: 'admin@biz-a.gr' },
          },
        ],
      })

      const result = await service.getDetail(platformUser, 'op-a')

      expect(prisma.parkingOperator.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'op-a' } }),
      )
      expect(result).toEqual({
        id: 'op-a',
        name: 'Biz A',
        status: OperatorStatus.VERIFIED,
        facilityCount: 1,
        memberCount: 1,
        createdAt: new Date('2026-01-02'),
        facilities: [
          {
            id: 'f-1',
            name: 'Lot 1',
            address: 'Odos 1',
            isActive: true,
            isVerified: true,
            kind: 'BUSINESS',
          },
        ],
        plans: [{ id: 'p-1', name: 'Standard', isActive: true, isDefault: true }],
        members: [
          {
            userId: 'u-1',
            email: 'admin@biz-a.gr',
            role: 'ADMIN',
            createdAt: new Date('2026-01-03'),
            // Derived, not stored: an operator's own admin holds everything within it.
            scopes: [...ORG_PERMISSIONS],
          },
        ],
      })
    })

    it('throws OperatorNotFoundError when the operator does not exist', async () => {
      prisma.parkingOperator.findUnique.mockResolvedValue(null)

      await expect(service.getDetail(platformUser, 'nope')).rejects.toBeInstanceOf(
        OperatorNotFoundError,
      )
    })

    it('throws OperatorNotFoundError for the synthetic unclaimed-import operator without querying', async () => {
      await expect(service.getDetail(platformUser, UNCLAIMED_OPERATOR_ID)).rejects.toBeInstanceOf(
        OperatorNotFoundError,
      )
      expect(prisma.parkingOperator.findUnique).not.toHaveBeenCalled()
    })

    it('rejects a non-platform-admin actor (service-layer re-check)', async () => {
      await expect(service.getDetail(operatorUser, 'op-a')).rejects.toBeInstanceOf(
        ForbiddenException,
      )
      expect(prisma.parkingOperator.findUnique).not.toHaveBeenCalled()
    })
  })

  describe('suspend', () => {
    it('flips a VERIFIED operator to SUSPENDED in one conditional update', async () => {
      prisma.parkingOperator.updateMany.mockResolvedValue({ count: 1 })

      await expect(service.suspend(platformUser, 'op-a')).resolves.toBeUndefined()

      expect(prisma.parkingOperator.updateMany).toHaveBeenCalledWith({
        where: { id: 'op-a', status: OperatorStatus.VERIFIED },
        data: { status: OperatorStatus.SUSPENDED },
      })
      expect(prisma.parkingOperator.findUnique).not.toHaveBeenCalled()
    })

    it('throws OperatorNotSuspendableError when the operator is not VERIFIED', async () => {
      prisma.parkingOperator.updateMany.mockResolvedValue({ count: 0 })
      prisma.parkingOperator.findUnique.mockResolvedValue({ status: OperatorStatus.PENDING })

      await expect(service.suspend(platformUser, 'op-a')).rejects.toBeInstanceOf(
        OperatorNotSuspendableError,
      )
    })

    it('throws OperatorNotFoundError when the operator does not exist', async () => {
      prisma.parkingOperator.updateMany.mockResolvedValue({ count: 0 })
      prisma.parkingOperator.findUnique.mockResolvedValue(null)

      await expect(service.suspend(platformUser, 'nope')).rejects.toBeInstanceOf(
        OperatorNotFoundError,
      )
    })

    it('rejects a non-platform-admin actor (service-layer re-check)', async () => {
      await expect(service.suspend(operatorUser, 'op-a')).rejects.toBeInstanceOf(ForbiddenException)
      expect(prisma.parkingOperator.updateMany).not.toHaveBeenCalled()
    })

    it('writes exactly one operator.suspended audit row for the actor on success', async () => {
      prisma.parkingOperator.updateMany.mockResolvedValue({ count: 1 })

      await RequestContext.run({ ip: '203.0.113.9' }, () => service.suspend(platformUser, 'op-a'))

      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1)
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: {
          actorId: 'admin-1',
          actorRole: 'platform_admin',
          action: 'operator.suspended',
          entityType: 'ParkingOperator',
          entityId: 'op-a',
          ipAddress: '203.0.113.9',
        },
      })
    })

    it('writes no audit row when the transition is rejected', async () => {
      prisma.parkingOperator.updateMany.mockResolvedValue({ count: 0 })
      prisma.parkingOperator.findUnique.mockResolvedValue({ status: OperatorStatus.PENDING })

      await expect(service.suspend(platformUser, 'op-a')).rejects.toBeInstanceOf(
        OperatorNotSuspendableError,
      )
      expect(prisma.auditLog.create).not.toHaveBeenCalled()
    })
  })

  describe('reactivate', () => {
    it('flips a SUSPENDED operator back to VERIFIED without touching verifiedAt', async () => {
      prisma.parkingOperator.updateMany.mockResolvedValue({ count: 1 })

      await expect(service.reactivate(platformUser, 'op-a')).resolves.toBeUndefined()

      expect(prisma.parkingOperator.updateMany).toHaveBeenCalledWith({
        where: { id: 'op-a', status: OperatorStatus.SUSPENDED },
        data: { status: OperatorStatus.VERIFIED },
      })
      expect(prisma.parkingOperator.updateMany.mock.calls[0]![0].data).not.toHaveProperty(
        'verifiedAt',
      )
    })

    it('throws OperatorNotReactivatableError when the operator is not SUSPENDED', async () => {
      prisma.parkingOperator.updateMany.mockResolvedValue({ count: 0 })
      prisma.parkingOperator.findUnique.mockResolvedValue({ status: OperatorStatus.VERIFIED })

      await expect(service.reactivate(platformUser, 'op-a')).rejects.toBeInstanceOf(
        OperatorNotReactivatableError,
      )
    })

    it('throws OperatorNotFoundError when the operator does not exist', async () => {
      prisma.parkingOperator.updateMany.mockResolvedValue({ count: 0 })
      prisma.parkingOperator.findUnique.mockResolvedValue(null)

      await expect(service.reactivate(platformUser, 'nope')).rejects.toBeInstanceOf(
        OperatorNotFoundError,
      )
    })

    it('rejects a non-platform-admin actor (service-layer re-check)', async () => {
      await expect(service.reactivate(operatorUser, 'op-a')).rejects.toBeInstanceOf(
        ForbiddenException,
      )
      expect(prisma.parkingOperator.updateMany).not.toHaveBeenCalled()
    })

    it('writes exactly one operator.reactivated audit row for the actor on success', async () => {
      prisma.parkingOperator.updateMany.mockResolvedValue({ count: 1 })

      await service.reactivate(platformUser, 'op-a')

      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1)
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: {
          actorId: 'admin-1',
          actorRole: 'platform_admin',
          action: 'operator.reactivated',
          entityType: 'ParkingOperator',
          entityId: 'op-a',
          ipAddress: null,
        },
      })
    })

    it('writes no audit row when the transition is rejected', async () => {
      prisma.parkingOperator.updateMany.mockResolvedValue({ count: 0 })
      prisma.parkingOperator.findUnique.mockResolvedValue({ status: OperatorStatus.VERIFIED })

      await expect(service.reactivate(platformUser, 'op-a')).rejects.toBeInstanceOf(
        OperatorNotReactivatableError,
      )
      expect(prisma.auditLog.create).not.toHaveBeenCalled()
    })
  })
})
