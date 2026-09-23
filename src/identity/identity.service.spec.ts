import { ForbiddenException } from '@nestjs/common'
import { LifecycleStatus, OperatorMemberRole, UserRole } from '@prisma/client'
import type { AuthUser } from '@spark/types'
import type { PrismaService } from '../prisma/prisma.service'
import { IdentityService } from './identity.service'
import {
  AnonymisedAccountError,
  IdentityUserNotFoundError,
  SelfRoleAssignmentError,
  SuperAdminProtectedError,
} from './identity.types'

const SUPER: AuthUser = {
  id: 'super-1',
  email: 'owner@spark.invalid',
  role: 'super_admin',
  emailVerified: true,
}

const PLATFORM: AuthUser = {
  id: 'admin-1',
  email: 'admin@spark.invalid',
  role: 'platform_admin',
  emailVerified: true,
}

const OPERATOR: AuthUser = {
  id: 'op-1',
  email: 'op@spark.invalid',
  role: 'operator_admin',
  emailVerified: true,
}

function userRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'u-1',
    email: 'person@spark.invalid',
    displayName: 'A Person',
    role: UserRole.USER,
    emailVerified: true,
    lifecycleStatus: LifecycleStatus.ACTIVE,
    deletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    operatorMemberships: [],
    ...overrides,
  }
}

function makeHarness() {
  const tx = {
    user: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'u-1',
        role: UserRole.USER,
        deletedAt: null,
        operatorMemberships: [],
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  }
  const prisma = {
    $transaction: jest.fn(async (fn: (c: typeof tx) => unknown) => fn(tx)),
    user: {
      findMany: jest.fn().mockResolvedValue([userRow()]),
      count: jest.fn().mockResolvedValue(1),
      findFirst: jest.fn().mockResolvedValue({
        ...userRow(),
        updatedAt: new Date('2026-02-01T00:00:00.000Z'),
        sessionsValidFrom: null,
        lifecycleChangedAt: null,
        lifecycleChangedBy: null,
        lifecycleReason: null,
        purgeAfter: null,
      }),
    },
    auditLog: { findMany: jest.fn().mockResolvedValue([]) },
  }
  const service = new IdentityService(prisma as unknown as PrismaService)
  return { service, prisma, tx }
}

describe('IdentityService — authorization', () => {
  it.each([PLATFORM, OPERATOR])(
    'refuses %#: a caller without identity:user.read',
    async (actor) => {
      const { service, prisma } = makeHarness()

      await expect(service.list(actor, { skip: 0, take: 20 })).rejects.toBeInstanceOf(
        ForbiddenException,
      )
      await expect(service.get(actor, 'u-1')).rejects.toBeInstanceOf(ForbiddenException)

      expect(prisma.user.findMany).not.toHaveBeenCalled()
      expect(prisma.user.findFirst).not.toHaveBeenCalled()
    },
  )

  it('admits a super admin', async () => {
    const { service } = makeHarness()

    await expect(service.list(SUPER, { skip: 0, take: 20 })).resolves.toMatchObject({ total: 1 })
    await expect(service.get(SUPER, 'u-1')).resolves.toMatchObject({ id: 'u-1' })
  })
})

describe('IdentityService — listing', () => {
  /**
   * The single most load-bearing detail in this service: the Prisma lifecycle extension
   * narrows every User read to ACTIVE unless the query names lifecycleStatus itself. A
   * directory that silently could not see suspended or deleted accounts would look like it
   * was working while hiding exactly what it exists to surface.
   */
  it('opts out of the lifecycle filter so suspended and deleted accounts are visible', async () => {
    const { service, prisma } = makeHarness()

    await service.list(SUPER, { skip: 0, take: 20 })

    const where = prisma.user.findMany.mock.calls[0][0].where as {
      lifecycleStatus: { in: LifecycleStatus[] }
    }
    expect(where.lifecycleStatus.in).toEqual(
      expect.arrayContaining([
        LifecycleStatus.ACTIVE,
        LifecycleStatus.ARCHIVED,
        LifecycleStatus.TOMBSTONED,
        LifecycleStatus.PURGED,
      ]),
    )
  })

  it('narrows to one status when asked, without widening it back', async () => {
    const { service, prisma } = makeHarness()

    await service.list(SUPER, {
      skip: 0,
      take: 20,
      lifecycleStatus: LifecycleStatus.ARCHIVED,
    })

    const where = prisma.user.findMany.mock.calls[0][0].where as Record<string, unknown>
    expect(where.lifecycleStatus).toBe(LifecycleStatus.ARCHIVED)
  })

  it('searches email and display name together, case insensitively', async () => {
    const { service, prisma } = makeHarness()

    await service.list(SUPER, { skip: 0, take: 20, q: 'nikos' })

    const where = prisma.user.findMany.mock.calls[0][0].where as { AND: unknown[] }
    expect(where.AND).toContainEqual({
      OR: [
        { email: { contains: 'nikos', mode: 'insensitive' } },
        { displayName: { contains: 'nikos', mode: 'insensitive' } },
      ],
    })
  })

  it('filters by role and by operator membership', async () => {
    const { service, prisma } = makeHarness()

    await service.list(SUPER, {
      skip: 0,
      take: 20,
      role: UserRole.OPERATOR_ADMIN,
      operatorId: 'op-9',
    })

    const where = prisma.user.findMany.mock.calls[0][0].where as { AND: unknown[] }
    expect(where.AND).toContainEqual({ role: UserRole.OPERATOR_ADMIN })
    expect(where.AND).toContainEqual({
      operatorMemberships: { some: { operatorId: 'op-9' } },
    })
  })

  it('counts with the same predicate it lists with', async () => {
    const { service, prisma } = makeHarness()

    await service.list(SUPER, { skip: 0, take: 20, q: 'nikos' })

    expect(prisma.user.count.mock.calls[0][0].where).toEqual(
      prisma.user.findMany.mock.calls[0][0].where,
    )
  })

  it('reports the page window back to the caller', async () => {
    const { service, prisma } = makeHarness()
    prisma.user.count.mockResolvedValue(97)

    const page = await service.list(SUPER, { skip: 40, take: 20 })

    expect(page).toMatchObject({ total: 97, skip: 40, take: 20 })
    expect(prisma.user.findMany.mock.calls[0][0]).toMatchObject({ skip: 40, take: 20 })
  })
})

describe('IdentityService — detail', () => {
  it('flattens memberships to their operator names', async () => {
    const { service, prisma } = makeHarness()
    prisma.user.findFirst.mockResolvedValue({
      ...userRow({
        operatorMemberships: [
          { role: OperatorMemberRole.ADMIN, operator: { id: 'op-1', name: 'Syntagma' } },
        ],
      }),
      updatedAt: new Date(),
      sessionsValidFrom: null,
      lifecycleChangedAt: null,
      lifecycleChangedBy: null,
      lifecycleReason: null,
      purgeAfter: null,
    })

    const detail = await service.get(SUPER, 'u-1')

    expect(detail.memberships).toEqual([
      { operatorId: 'op-1', operatorName: 'Syntagma', role: OperatorMemberRole.ADMIN },
    ])
  })

  // Anonymisation and administrative archival are different columns with different
  // reversibility, and the UI has to be able to tell them apart.
  it('reports self-service anonymisation separately from lifecycle status', async () => {
    const { service, prisma } = makeHarness()
    prisma.user.findFirst.mockResolvedValue({
      ...userRow({
        deletedAt: new Date('2026-03-03T00:00:00.000Z'),
        lifecycleStatus: LifecycleStatus.ACTIVE,
      }),
      updatedAt: new Date(),
      sessionsValidFrom: null,
      lifecycleChangedAt: null,
      lifecycleChangedBy: null,
      lifecycleReason: null,
      purgeAfter: null,
    })

    const detail = await service.get(SUPER, 'u-1')

    expect(detail.anonymisedAt).toBe('2026-03-03T00:00:00.000Z')
    expect(detail.lifecycleStatus).toBe(LifecycleStatus.ACTIVE)
  })

  it('queries the audit trail by entityType as well as id, to hit the composite index', async () => {
    const { service, prisma } = makeHarness()

    await service.get(SUPER, 'u-1')

    expect(prisma.auditLog.findMany.mock.calls[0][0].where).toEqual({
      entityType: 'User',
      entityId: 'u-1',
    })
  })

  it('raises a typed not-found rather than returning null', async () => {
    const { service, prisma } = makeHarness()
    prisma.user.findFirst.mockResolvedValue(null)

    await expect(service.get(SUPER, 'ghost')).rejects.toBeInstanceOf(IdentityUserNotFoundError)
  })
})

describe('IdentityService — assigning a platform role', () => {
  const grant = { role: UserRole.PLATFORM_ADMIN, reason: 'joined the ops team' } as const

  it('refuses a caller without identity:role.assign', async () => {
    const { service, tx } = makeHarness()

    await expect(service.assignRole(PLATFORM, 'u-1', grant)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
    expect(tx.user.update).not.toHaveBeenCalled()
  })

  // A single compromised account must not be able to widen its own authority.
  it('refuses to let a super admin re-role themselves', async () => {
    const { service, tx } = makeHarness()

    await expect(service.assignRole(SUPER, SUPER.id, grant)).rejects.toBeInstanceOf(
      SelfRoleAssignmentError,
    )
    expect(tx.user.update).not.toHaveBeenCalled()
  })

  it('refuses to touch a super admin, pointing at the demotion flow instead', async () => {
    const { service, tx } = makeHarness()
    tx.user.findFirst.mockResolvedValue({
      id: 'u-1',
      role: UserRole.SUPER_ADMIN,
      deletedAt: null,
      operatorMemberships: [],
    })

    await expect(service.assignRole(SUPER, 'u-1', grant)).rejects.toBeInstanceOf(
      SuperAdminProtectedError,
    )
    expect(tx.user.update).not.toHaveBeenCalled()
  })

  it('refuses an account its owner already deleted and anonymised', async () => {
    const { service, tx } = makeHarness()
    tx.user.findFirst.mockResolvedValue({
      id: 'u-1',
      role: UserRole.USER,
      deletedAt: new Date(),
      operatorMemberships: [],
    })

    await expect(service.assignRole(SUPER, 'u-1', grant)).rejects.toBeInstanceOf(
      AnonymisedAccountError,
    )
  })

  it('raises not-found rather than creating anything', async () => {
    const { service, tx } = makeHarness()
    tx.user.findFirst.mockResolvedValue(null)

    await expect(service.assignRole(SUPER, 'ghost', grant)).rejects.toBeInstanceOf(
      IdentityUserNotFoundError,
    )
  })

  it('grants the role, revokes outstanding tokens, and audits with a motive', async () => {
    const { service, tx } = makeHarness()

    await service.assignRole(SUPER, 'u-1', grant)

    expect(tx.user.update.mock.calls[0][0].data).toMatchObject({
      role: UserRole.PLATFORM_ADMIN,
    })
    expect(tx.user.update.mock.calls[0][0].data.sessionsValidFrom).toBeInstanceOf(Date)

    const audit = tx.auditLog.create.mock.calls[0][0].data
    expect(audit).toMatchObject({
      action: 'user.role_changed',
      entityType: 'User',
      entityId: 'u-1',
    })
    expect(audit.payload).toMatchObject({
      from: UserRole.USER,
      to: UserRole.PLATFORM_ADMIN,
      reason: 'joined the ops team',
    })
  })

  /**
   * Revoking platform authority is not the same as demoting to USER. reconcileUserRole owns
   * the operator axis, and writing USER over someone who still administers an operator
   * would leave the two role axes disagreeing until a membership change corrected it.
   */
  it.each([
    [[{ role: OperatorMemberRole.ADMIN }], UserRole.OPERATOR_ADMIN],
    [[{ role: OperatorMemberRole.STAFF }], UserRole.OPERATOR_STAFF],
    [[], UserRole.USER],
  ])('revoking authority with %j falls back to %s', async (memberships, expected) => {
    const { service, tx } = makeHarness()
    tx.user.findFirst.mockResolvedValue({
      id: 'u-1',
      role: UserRole.PLATFORM_ADMIN,
      deletedAt: null,
      operatorMemberships: memberships,
    })

    await service.assignRole(SUPER, 'u-1', { role: UserRole.USER, reason: 'left ops' })

    expect(tx.user.update.mock.calls[0][0].data).toMatchObject({ role: expected })
  })

  it('writes nothing when the role would not actually change', async () => {
    const { service, tx } = makeHarness()
    tx.user.findFirst.mockResolvedValue({
      id: 'u-1',
      role: UserRole.PLATFORM_ADMIN,
      deletedAt: null,
      operatorMemberships: [],
    })

    await service.assignRole(SUPER, 'u-1', grant)

    expect(tx.user.update).not.toHaveBeenCalled()
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })
})
