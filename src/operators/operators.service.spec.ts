import { ForbiddenException } from '@nestjs/common'
import { OperatorStatus } from '@prisma/client'
import type { AuthUser } from '@spark/types'
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
    parkingOperator: { findMany: jest.Mock; findUnique: jest.Mock; updateMany: jest.Mock }
  }
  let service: OperatorsService

  beforeEach(() => {
    prisma = {
      parkingOperator: { findMany: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn() },
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
  })
})
