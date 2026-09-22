import { ForbiddenException } from '@nestjs/common'
import { UserRole } from '@prisma/client'
import type { AuthUser } from '@spark/types'
import { LifecycleActionBlockedError } from '../common/errors/domain.errors'
import { SuperAdminProtectedError } from '../identity/identity.types'
import type { PrismaService } from '../prisma/prisma.service'
import { LifecycleAdminService } from './lifecycle-admin.service'
import type { LifecycleApprovalService } from './lifecycle-approval.service'
import type { LifecycleImpactService } from './lifecycle-impact.service'
import type { LifecyclePurgeService } from './lifecycle-purge.service'
import type { LifecycleService } from './lifecycle.service'
import type { ImpactReport } from './lifecycle.types'

const PLATFORM: AuthUser = {
  id: 'admin-1',
  email: 'admin@spark.invalid',
  role: 'platform_admin',
  emailVerified: true,
}

const SUPER: AuthUser = {
  id: 'super-1',
  email: 'owner@spark.invalid',
  role: 'super_admin',
  emailVerified: true,
}

const OPERATOR: AuthUser = {
  id: 'op-admin',
  email: 'op@spark.invalid',
  role: 'operator_admin',
  emailVerified: true,
}

const CLEAN: ImpactReport = { blockers: [], warnings: [], effects: [], requiresForce: false }

const WARNED: ImpactReport = {
  blockers: [],
  warnings: [{ code: 'FACILITY_SAVED_BY_USERS', message: '3 customers saved it', count: 3 }],
  effects: [],
  requiresForce: true,
}

const BLOCKED: ImpactReport = {
  blockers: [
    {
      code: 'FACILITY_HAS_UNHONOURED_BOOKINGS',
      message: '2 booking(s) are still to be honoured at this facility.',
      remedy: 'Cancel and refund them first.',
    },
  ],
  warnings: [],
  effects: [],
  requiresForce: false,
}

function makeHarness(report: ImpactReport = CLEAN) {
  const lifecycle = {
    archiveFacility: jest.fn().mockResolvedValue(undefined),
    archiveTariffPlan: jest.fn().mockResolvedValue(undefined),
    archiveOperator: jest.fn().mockResolvedValue(undefined),
    archiveUser: jest.fn().mockResolvedValue(undefined),
    restoreFacility: jest.fn().mockResolvedValue(undefined),
    restoreTariffPlan: jest.fn().mockResolvedValue(undefined),
    restoreOperator: jest.fn().mockResolvedValue(undefined),
    restoreUser: jest.fn().mockResolvedValue(undefined),
    tombstoneFacility: jest.fn().mockResolvedValue(undefined),
    tombstoneTariffPlan: jest.fn().mockResolvedValue(undefined),
    tombstoneOperator: jest.fn().mockResolvedValue(undefined),
    tombstoneUser: jest.fn().mockResolvedValue(undefined),
  }
  const impact = { preview: jest.fn().mockResolvedValue(report) }
  const approvals = {
    request: jest.fn().mockResolvedValue({ id: 'ap-1' }),
    list: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    claim: jest.fn(),
    reject: jest.fn().mockResolvedValue({ id: 'ap-1' }),
    resourceTypeOf: jest.fn().mockResolvedValue('facility'),
  }
  const purge = { purgeOne: jest.fn().mockResolvedValue(undefined) }
  // Only listTrash touches Prisma here, and it reads one delegate per resource type — which
  // is exactly what lets a test assert that the `user` delegate was never queried at all.
  const delegate = () => ({
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
  })
  const prisma = {
    facility: delegate(),
    tariffPlan: delegate(),
    parkingOperator: delegate(),
    // findFirst backs the super-admin protection check, which reads the target's role
    // before any destructive verb. An ordinary account by default.
    user: { ...delegate(), findFirst: jest.fn().mockResolvedValue({ role: UserRole.USER }) },
  }

  const service = new LifecycleAdminService(
    prisma as unknown as PrismaService,
    lifecycle as unknown as LifecycleService,
    impact as unknown as LifecycleImpactService,
    approvals as unknown as LifecycleApprovalService,
    purge as unknown as LifecyclePurgeService,
  )

  return { service, lifecycle, impact, approvals, purge, prisma }
}

describe('LifecycleAdminService — service-layer authorization', () => {
  it('refuses every mutating action to a caller without the permission, not only the controller', async () => {
    const { service, lifecycle, approvals } = makeHarness()

    await expect(service.archive(OPERATOR, 'facility', 'f1', 'why')).rejects.toBeInstanceOf(
      ForbiddenException,
    )
    await expect(service.restore(OPERATOR, 'facility', 'f1')).rejects.toBeInstanceOf(
      ForbiddenException,
    )
    await expect(service.tombstone(OPERATOR, 'facility', 'f1', 'why')).rejects.toBeInstanceOf(
      ForbiddenException,
    )
    await expect(service.requestPurge(OPERATOR, 'facility', 'f1', 'why')).rejects.toBeInstanceOf(
      ForbiddenException,
    )
    await expect(service.approve(OPERATOR, 'ap-1')).rejects.toBeInstanceOf(ForbiddenException)
    await expect(service.reject(OPERATOR, 'ap-1', 'no')).rejects.toBeInstanceOf(ForbiddenException)
    await expect(service.listApprovals(OPERATOR)).rejects.toBeInstanceOf(ForbiddenException)
    await expect(service.listTrash(OPERATOR, { skip: 0, take: 20 })).rejects.toBeInstanceOf(
      ForbiddenException,
    )

    expect(lifecycle.archiveFacility).not.toHaveBeenCalled()
    expect(approvals.request).not.toHaveBeenCalled()
  })
})

/**
 * The platform_admin / super_admin boundary.
 *
 * This surface is generic over its resource type and `user` is one of the four, so without
 * these checks every platform admin would reach every account on the platform through it.
 * Since platform admins deliberately keep every platform:* capability, this is the ONLY
 * thing separating the two tiers — hence a case per verb rather than one representative.
 */
describe('LifecycleAdminService — the user-account boundary', () => {
  it.each([
    ['archive', (s: LifecycleAdminService, a: AuthUser) => s.archive(a, 'user', 'u1', 'why')],
    ['restore', (s: LifecycleAdminService, a: AuthUser) => s.restore(a, 'user', 'u1')],
    ['tombstone', (s: LifecycleAdminService, a: AuthUser) => s.tombstone(a, 'user', 'u1', 'why')],
    ['purge', (s: LifecycleAdminService, a: AuthUser) => s.requestPurge(a, 'user', 'u1', 'why')],
    [
      'impact preview',
      (s: LifecycleAdminService, a: AuthUser) => s.previewImpact(a, 'user', 'u1', 'archive'),
    ],
  ] as const)('refuses %s of a user account to a platform admin', async (_name, call) => {
    const { service, lifecycle, approvals } = makeHarness()

    await expect(call(service, PLATFORM)).rejects.toBeInstanceOf(ForbiddenException)

    expect(lifecycle.archiveUser).not.toHaveBeenCalled()
    expect(lifecycle.restoreUser).not.toHaveBeenCalled()
    expect(lifecycle.tombstoneUser).not.toHaveBeenCalled()
    expect(approvals.request).not.toHaveBeenCalled()
  })

  it.each(['facility', 'tariff-plan', 'operator'] as const)(
    'leaves %s administration untouched for a platform admin',
    async (type) => {
      const { service } = makeHarness()

      await expect(service.archive(PLATFORM, type, 'x1', 'why')).resolves.toBeUndefined()
      await expect(service.restore(PLATFORM, type, 'x1')).resolves.toBeUndefined()
      await expect(service.tombstone(PLATFORM, type, 'x1', 'why')).resolves.toBeUndefined()
    },
  )

  /**
   * Super admins are unreachable by the ordinary verbs even for another super admin, so the
   * only way the tier shrinks is the demotion flow, which needs a second super admin. Any
   * verb that stopped checking this would silently let one compromised super admin delete
   * every other one.
   */
  it.each([
    ['archive', (s: LifecycleAdminService) => s.archive(SUPER, 'user', 'u1', 'why')],
    ['tombstone', (s: LifecycleAdminService) => s.tombstone(SUPER, 'user', 'u1', 'why')],
    ['purge', (s: LifecycleAdminService) => s.requestPurge(SUPER, 'user', 'u1', 'why')],
  ] as const)('refuses to %s a super administrator, even for a super admin', async (_n, call) => {
    const { service, prisma, lifecycle, approvals } = makeHarness()
    prisma.user.findFirst.mockResolvedValue({ role: UserRole.SUPER_ADMIN })

    await expect(call(service)).rejects.toBeInstanceOf(SuperAdminProtectedError)

    expect(lifecycle.archiveUser).not.toHaveBeenCalled()
    expect(lifecycle.tombstoneUser).not.toHaveBeenCalled()
    expect(approvals.request).not.toHaveBeenCalled()
  })

  it('still protects a super admin who has already been archived', async () => {
    const { service, prisma } = makeHarness()
    prisma.user.findFirst.mockResolvedValue({ role: UserRole.SUPER_ADMIN })

    await expect(service.tombstone(SUPER, 'user', 'u1', 'why')).rejects.toBeInstanceOf(
      SuperAdminProtectedError,
    )

    // The lookup must name lifecycleStatus, or the Prisma extension narrows it to ACTIVE
    // and an archived super admin reads back as "not found" — and so as unprotected.
    const where = prisma.user.findFirst.mock.calls[0][0].where as Record<string, unknown>
    expect(where).toHaveProperty('lifecycleStatus')
  })

  it('lets a super admin run the full lifecycle on an account', async () => {
    const { service, lifecycle } = makeHarness()

    await service.archive(SUPER, 'user', 'u1', 'abuse report')
    await service.restore(SUPER, 'user', 'u1')
    await service.tombstone(SUPER, 'user', 'u1', 'abuse report')

    expect(lifecycle.archiveUser).toHaveBeenCalled()
    expect(lifecycle.restoreUser).toHaveBeenCalled()
    expect(lifecycle.tombstoneUser).toHaveBeenCalled()
  })

  it('withholds deleted accounts from a platform admin browsing the trash', async () => {
    const { service, prisma } = makeHarness()

    await service.listTrash(PLATFORM, { skip: 0, take: 20 })

    expect(prisma.user.findMany).not.toHaveBeenCalled()
    expect(prisma.user.count).not.toHaveBeenCalled()
    expect(prisma.facility.findMany).toHaveBeenCalled()
  })

  it('refuses a platform admin who asks for deleted accounts by name', async () => {
    const { service, prisma } = makeHarness()

    // A 403 rather than an empty page: silently returning nothing would read as
    // "no deleted accounts exist", which is a different and untrue claim.
    await expect(
      service.listTrash(PLATFORM, { skip: 0, take: 20, resourceType: 'user' }),
    ).rejects.toBeInstanceOf(ForbiddenException)

    expect(prisma.user.findMany).not.toHaveBeenCalled()
  })

  it('shows a super admin the deleted accounts', async () => {
    const { service, prisma } = makeHarness()

    await service.listTrash(SUPER, { skip: 0, take: 20 })

    expect(prisma.user.findMany).toHaveBeenCalled()
  })

  it('withholds pending account purges from a platform admin', async () => {
    const { service, approvals } = makeHarness()
    approvals.list.mockResolvedValue({
      items: [
        { id: 'ap-1', resourceType: 'user', resourceId: 'u1' },
        { id: 'ap-2', resourceType: 'facility', resourceId: 'f1' },
      ],
      total: 2,
    })

    const seen = await service.listApprovals(PLATFORM)

    expect(seen.items.map((a) => a.id)).toEqual(['ap-2'])
    expect(seen.total).toBe(1)
  })

  it.each([
    ['approve', (s: LifecycleAdminService) => s.approve(PLATFORM, 'ap-1')],
    ['reject', (s: LifecycleAdminService) => s.reject(PLATFORM, 'ap-1', 'no')],
  ] as const)(
    'refuses to let a platform admin %s an account purge decided by its row, not its URL',
    async (_name, call) => {
      const { service, approvals, purge } = makeHarness()
      approvals.resourceTypeOf.mockResolvedValue('user')

      await expect(call(service)).rejects.toBeInstanceOf(ForbiddenException)

      // Refused BEFORE the approval is consumed, so the request survives for a super admin.
      expect(approvals.claim).not.toHaveBeenCalled()
      expect(approvals.reject).not.toHaveBeenCalled()
      expect(purge.purgeOne).not.toHaveBeenCalled()
    },
  )
})

describe('LifecycleAdminService — blockers versus warnings', () => {
  it('refuses the action when the dry run found a blocker, carrying the same list', async () => {
    const { service, lifecycle } = makeHarness(BLOCKED)

    await expect(service.archive(PLATFORM, 'facility', 'f1', 'seasonal')).rejects.toBeInstanceOf(
      LifecycleActionBlockedError,
    )
    await expect(service.archive(PLATFORM, 'facility', 'f1', 'seasonal')).rejects.toMatchObject({
      blockers: BLOCKED.blockers,
    })
    expect(lifecycle.archiveFacility).not.toHaveBeenCalled()
  })

  it('proceeds through a warning — consent is the UI’s job, not a second gate', async () => {
    const { service, lifecycle } = makeHarness(WARNED)

    await service.archive(PLATFORM, 'facility', 'f1', 'seasonal')

    expect(lifecycle.archiveFacility).toHaveBeenCalledWith(
      { id: PLATFORM.id, role: PLATFORM.role },
      'f1',
      'seasonal',
    )
  })

  it('never blocks a restore on the impact preview', async () => {
    const { service, lifecycle, impact } = makeHarness(BLOCKED)

    await service.restore(PLATFORM, 'facility', 'f1', 'reinstated on appeal')

    expect(impact.preview).not.toHaveBeenCalled()
    expect(lifecycle.restoreFacility).toHaveBeenCalledWith(
      { id: PLATFORM.id, role: PLATFORM.role },
      'f1',
      'reinstated on appeal',
    )
  })
})

describe('LifecycleAdminService — dispatch', () => {
  // The actor differs by row on purpose: only super_admin may reach the `user` resource,
  // which is the whole platform_admin / super_admin boundary.
  it.each([
    ['facility', 'archiveFacility', 'tombstoneFacility', PLATFORM],
    ['tariff-plan', 'archiveTariffPlan', 'tombstoneTariffPlan', PLATFORM],
    ['operator', 'archiveOperator', 'tombstoneOperator', PLATFORM],
    ['user', 'archiveUser', 'tombstoneUser', SUPER],
  ] as const)(
    'routes %s to its own lifecycle methods',
    async (type, archiveFn, tombstoneFn, actor) => {
      const { service, lifecycle } = makeHarness()

      await service.archive(actor, type, 'x1', 'because')
      await service.tombstone(actor, type, 'x1', 'because')

      expect(lifecycle[archiveFn]).toHaveBeenCalledWith(
        { id: actor.id, role: actor.role },
        'x1',
        'because',
      )
      expect(lifecycle[tombstoneFn]).toHaveBeenCalledWith(
        { id: actor.id, role: actor.role },
        'x1',
        'because',
      )
    },
  )

  it('purge requests an approval instead of destroying anything', async () => {
    const { service, approvals, purge } = makeHarness()

    await service.requestPurge(PLATFORM, 'facility', 'f1', 'GDPR erasure 4471')

    expect(approvals.request).toHaveBeenCalledWith(PLATFORM, 'facility', 'f1', 'GDPR erasure 4471')
    expect(purge.purgeOne).not.toHaveBeenCalled()
  })

  it('approving re-runs the dry run before destroying, then purges the claimed resource', async () => {
    const { service, approvals, impact, purge } = makeHarness()
    approvals.claim.mockResolvedValue({
      id: 'ap-1',
      action: 'purge',
      resourceType: 'tariff-plan',
      resourceId: 'p1',
      reason: 'duplicate plan',
      requestedBy: 'admin-9',
      requestedByRole: 'platform_admin',
      status: 'APPROVED',
      expiresAt: new Date(),
      decidedBy: PLATFORM.id,
      decidedByRole: PLATFORM.role,
      decidedAt: new Date(),
      decisionReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    approvals.resourceTypeOf.mockResolvedValue('tariff-plan')

    const outcome = await service.approve(PLATFORM, 'ap-1')

    expect(impact.preview).toHaveBeenCalledWith('tariff-plan', 'p1', 'purge')
    expect(purge.purgeOne).toHaveBeenCalledWith(
      { id: PLATFORM.id, role: PLATFORM.role },
      'tariff-plan',
      'p1',
      { reason: 'duplicate plan', approvalId: 'ap-1', requestedBy: 'admin-9' },
    )
    expect(outcome.purged).toBe(true)
  })

  it('refuses to purge when the state changed between request and approval', async () => {
    const { service, approvals, purge } = makeHarness(BLOCKED)
    approvals.claim.mockResolvedValue({
      id: 'ap-1',
      action: 'purge',
      resourceType: 'facility',
      resourceId: 'f1',
      reason: 'duplicate',
      requestedBy: 'admin-9',
      requestedByRole: 'platform_admin',
      status: 'APPROVED',
      expiresAt: new Date(),
      decidedBy: PLATFORM.id,
      decidedByRole: PLATFORM.role,
      decidedAt: new Date(),
      decisionReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    await expect(service.approve(PLATFORM, 'ap-1')).rejects.toBeInstanceOf(
      LifecycleActionBlockedError,
    )
    expect(purge.purgeOne).not.toHaveBeenCalled()
  })
})
