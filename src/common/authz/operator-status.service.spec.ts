import { OperatorStatus } from '@prisma/client'
import type { AuthUser, UserRole } from '@spark/types'
import type { PrismaService } from '../../prisma/prisma.service'
import { OperatorSuspendedError } from '../errors/domain.errors'
import { OperatorStatusService } from './operator-status.service'

function user(role: UserRole): AuthUser {
  return { id: 'u1', email: `${role}@spark.gr`, role, emailVerified: true }
}

describe('OperatorStatusService', () => {
  let findFirst: jest.Mock
  let service: OperatorStatusService

  // Stands in for Prisma: honours the status filter in the where clause, so a test can
  // hand the user several memberships and see which one the query actually matches.
  function withMemberships(...statuses: OperatorStatus[]) {
    findFirst.mockImplementation(
      async ({ where }: { where: { operator?: { status?: OperatorStatus } } }) => {
        const wanted = where.operator?.status
        const match = statuses.find((status) => wanted === undefined || status === wanted)
        return match ? { operator: { status: match } } : null
      },
    )
  }

  beforeEach(() => {
    findFirst = jest.fn().mockResolvedValue(null)
    service = new OperatorStatusService({
      operatorMembership: { findFirst },
    } as unknown as PrismaService)
  })

  it('allows an operator whose only membership is active', async () => {
    withMemberships(OperatorStatus.VERIFIED)
    await expect(service.assertOperatorActive(user('operator_admin'))).resolves.toBeUndefined()
  })

  it('rejects an operator whose only membership is suspended', async () => {
    withMemberships(OperatorStatus.SUSPENDED)
    await expect(service.assertOperatorActive(user('operator_admin'))).rejects.toBeInstanceOf(
      OperatorSuspendedError,
    )
  })

  it('rejects when ANY membership is suspended, even behind an active one', async () => {
    withMemberships(OperatorStatus.VERIFIED, OperatorStatus.SUSPENDED)
    await expect(service.assertOperatorActive(user('operator_staff'))).rejects.toBeInstanceOf(
      OperatorSuspendedError,
    )
  })

  it('allows a multi-operator user whose operators are all active', async () => {
    withMemberships(OperatorStatus.VERIFIED, OperatorStatus.PENDING)
    await expect(service.assertOperatorActive(user('operator_staff'))).resolves.toBeUndefined()
  })

  it('treats an operator user with no membership row as active', async () => {
    await expect(service.assertOperatorActive(user('operator_admin'))).resolves.toBeUndefined()
  })

  it.each<UserRole>(['user', 'platform_admin'])(
    'never queries membership for a %s',
    async (role) => {
      withMemberships(OperatorStatus.SUSPENDED)
      await expect(service.assertOperatorActive(user(role))).resolves.toBeUndefined()
      expect(findFirst).not.toHaveBeenCalled()
    },
  )
})
