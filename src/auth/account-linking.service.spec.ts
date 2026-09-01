import type { AuthContext } from '@spark/auth'
import type { PrismaService } from '../prisma/prisma.service'
import { AccountLinkingService } from './account-linking.service'

function makeHarness() {
  const prisma = { user: { findFirst: jest.fn() } }
  const auth = { signIn: jest.fn() }
  const service = new AccountLinkingService(
    prisma as unknown as PrismaService,
    auth as unknown as AuthContext,
  )
  return { service, prisma, auth }
}

describe('AccountLinkingService', () => {
  describe('resolve', () => {
    it('reports free when no row exists for the address', async () => {
      const { service, prisma } = makeHarness()
      prisma.user.findFirst.mockResolvedValue(null)

      await expect(service.resolve('nobody@spark.gr')).resolves.toEqual({ kind: 'free' })
    })

    it('reports linkable for a mobile-only account with no operator membership', async () => {
      const { service, prisma } = makeHarness()
      prisma.user.findFirst.mockResolvedValue({
        id: 'user-1',
        role: 'USER',
        lifecycleStatus: 'ACTIVE',
        operatorMemberships: [],
      })

      await expect(service.resolve('driver@spark.gr')).resolves.toEqual({
        kind: 'linkable',
        userId: 'user-1',
      })
    })

    it('reports taken for an account that already holds a privileged role', async () => {
      const { service, prisma } = makeHarness()
      prisma.user.findFirst.mockResolvedValue({
        id: 'user-1',
        role: 'OPERATOR_ADMIN',
        lifecycleStatus: 'ACTIVE',
        operatorMemberships: [],
      })

      await expect(service.resolve('owner@spark.gr')).resolves.toEqual({ kind: 'taken' })
    })

    it('reports taken for a USER-role account that is not ACTIVE', async () => {
      const { service, prisma } = makeHarness()
      prisma.user.findFirst.mockResolvedValue({
        id: 'user-1',
        role: 'USER',
        lifecycleStatus: 'ARCHIVED',
        operatorMemberships: [],
      })

      await expect(service.resolve('driver@spark.gr')).resolves.toEqual({ kind: 'taken' })
    })

    // Should never happen given current invariants (a USER-role row never has one), but the
    // check is deliberately explicit rather than inferred from role alone.
    it('reports taken for a USER-role account that somehow already has a membership', async () => {
      const { service, prisma } = makeHarness()
      prisma.user.findFirst.mockResolvedValue({
        id: 'user-1',
        role: 'USER',
        lifecycleStatus: 'ACTIVE',
        operatorMemberships: [{ id: 'mem-1' }],
      })

      await expect(service.resolve('driver@spark.gr')).resolves.toEqual({ kind: 'taken' })
    })

    it('looks past the lifecycle filter so an archived or purged address still counts', async () => {
      const { service, prisma } = makeHarness()
      prisma.user.findFirst.mockResolvedValue(null)

      await service.resolve('someone@spark.gr')

      const where = prisma.user.findFirst.mock.calls[0]![0].where as Record<string, unknown>
      expect(where).toHaveProperty('lifecycleStatus')
    })
  })

  describe('verifyOwnership', () => {
    it('delegates straight to signIn', async () => {
      const { service, auth } = makeHarness()
      const result = { session: { user: { id: 'user-1' } } }
      auth.signIn.mockResolvedValue(result)

      await expect(service.verifyOwnership('driver@spark.gr', 'pw')).resolves.toBe(result)
      expect(auth.signIn).toHaveBeenCalledWith({ email: 'driver@spark.gr', password: 'pw' })
    })

    it('propagates a failed sign-in rather than swallowing it', async () => {
      const { service, auth } = makeHarness()
      auth.signIn.mockRejectedValue(new Error('invalid credentials'))

      await expect(service.verifyOwnership('driver@spark.gr', 'wrong')).rejects.toThrow(
        'invalid credentials',
      )
    })
  })
})
