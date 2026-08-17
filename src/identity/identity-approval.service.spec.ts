import { ForbiddenException } from '@nestjs/common'
import { ApprovalStatus, LifecycleStatus, OperatorMemberRole, UserRole } from '@prisma/client'
import type { AuthUser } from '@spark/types'
import {
  ApprovalAlreadyPendingError,
  ApprovalNotPendingError,
  SelfApprovalError,
} from '../common/errors/domain.errors'
import type { PrismaService } from '../prisma/prisma.service'
import { IdentityApprovalService, DEMOTE_ACTION } from './identity-approval.service'
import {
  LastSuperAdminError,
  NotASuperAdminError,
  SelfRoleAssignmentError,
  SuperAdminApproverUnavailableError,
} from './identity.types'

const REQUESTER: AuthUser = {
  id: 'super-1',
  email: 'one@spark.invalid',
  role: 'super_admin',
  emailVerified: true,
}

const APPROVER: AuthUser = {
  id: 'super-2',
  email: 'two@spark.invalid',
  role: 'super_admin',
  emailVerified: true,
}

const PLATFORM: AuthUser = {
  id: 'admin-1',
  email: 'admin@spark.invalid',
  role: 'platform_admin',
  emailVerified: true,
}

const TARGET = 'super-3'

function approvalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ap-1',
    action: DEMOTE_ACTION,
    resourceType: 'user',
    resourceId: TARGET,
    reason: 'left the company',
    requestedBy: REQUESTER.id,
    requestedByRole: 'super_admin',
    status: ApprovalStatus.PENDING,
    expiresAt: new Date(Date.now() + 60_000),
    decidedBy: null,
    decidedByRole: null,
    decidedAt: null,
    decisionReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function makeHarness() {
  const tx = {
    pendingApproval: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(approvalRow()),
      create: jest.fn().mockResolvedValue(approvalRow()),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    user: {
      findFirst: jest.fn().mockResolvedValue({
        role: UserRole.SUPER_ADMIN,
        operatorMemberships: [],
      }),
      update: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(1),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  }

  const prisma = {
    $transaction: jest.fn(async (fn: (c: typeof tx) => unknown) => fn(tx)),
    pendingApproval: {
      findMany: jest.fn().mockResolvedValue([approvalRow()]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findUnique: jest.fn().mockResolvedValue(approvalRow()),
    },
    user: {
      findFirst: jest.fn().mockResolvedValue({ role: UserRole.SUPER_ADMIN }),
      count: jest.fn().mockResolvedValue(1),
    },
  }

  const service = new IdentityApprovalService(prisma as unknown as PrismaService)
  return { service, prisma, tx }
}

describe('IdentityApprovalService — authorization', () => {
  it('refuses every route to a platform admin', async () => {
    const { service } = makeHarness()

    await expect(service.requestDemotion(PLATFORM, TARGET, 'why')).rejects.toBeInstanceOf(
      ForbiddenException,
    )
    await expect(service.list(PLATFORM)).rejects.toBeInstanceOf(ForbiddenException)
    await expect(service.approve(PLATFORM, 'ap-1')).rejects.toBeInstanceOf(ForbiddenException)
    await expect(service.reject(PLATFORM, 'ap-1', 'no')).rejects.toBeInstanceOf(ForbiddenException)
  })
})

describe('IdentityApprovalService — requesting a demotion', () => {
  it('refuses to let a super admin demote themselves', async () => {
    const { service, tx } = makeHarness()

    await expect(service.requestDemotion(REQUESTER, REQUESTER.id, 'why')).rejects.toBeInstanceOf(
      SelfRoleAssignmentError,
    )
    expect(tx.pendingApproval.create).not.toHaveBeenCalled()
  })

  it('refuses when the target is not a super admin', async () => {
    const { service, prisma } = makeHarness()
    prisma.user.findFirst.mockResolvedValue({ role: UserRole.PLATFORM_ADMIN })

    await expect(service.requestDemotion(REQUESTER, TARGET, 'why')).rejects.toBeInstanceOf(
      NotASuperAdminError,
    )
  })

  // The situation the rule most exists for: one administrator cannot agree with themselves.
  it('fails closed when no second super admin could ever approve it', async () => {
    const { service, prisma, tx } = makeHarness()
    prisma.user.count.mockResolvedValue(0)

    await expect(service.requestDemotion(REQUESTER, TARGET, 'why')).rejects.toBeInstanceOf(
      SuperAdminApproverUnavailableError,
    )
    expect(tx.pendingApproval.create).not.toHaveBeenCalled()
  })

  it('refuses to demote the last super admin', async () => {
    const { service, prisma } = makeHarness()
    // Another super admin exists to approve, but none would survive the demotion itself.
    prisma.user.count.mockResolvedValueOnce(1).mockResolvedValueOnce(0)

    await expect(service.requestDemotion(REQUESTER, TARGET, 'why')).rejects.toBeInstanceOf(
      LastSuperAdminError,
    )
  })

  it('refuses a second request while one is already pending', async () => {
    const { service, tx } = makeHarness()
    tx.pendingApproval.findFirst.mockResolvedValue({ id: 'ap-existing' })

    await expect(service.requestDemotion(REQUESTER, TARGET, 'why')).rejects.toBeInstanceOf(
      ApprovalAlreadyPendingError,
    )
    expect(tx.pendingApproval.create).not.toHaveBeenCalled()
  })

  it('files the request and audits it without changing the role', async () => {
    const { service, tx } = makeHarness()

    const view = await service.requestDemotion(REQUESTER, TARGET, 'left the company')

    expect(view.status).toBe(ApprovalStatus.PENDING)
    expect(tx.pendingApproval.create.mock.calls[0][0].data).toMatchObject({
      action: DEMOTE_ACTION,
      resourceId: TARGET,
      requestedBy: REQUESTER.id,
    })
    expect(tx.user.update).not.toHaveBeenCalled()
    expect(tx.auditLog.create.mock.calls[0][0].data).toMatchObject({
      action: 'user.demotion_requested',
      entityType: 'User',
      entityId: TARGET,
    })
  })
})

describe('IdentityApprovalService — redeeming', () => {
  it('refuses to let the requester approve their own request', async () => {
    const { service, tx } = makeHarness()

    await expect(service.approve(REQUESTER, 'ap-1')).rejects.toBeInstanceOf(SelfApprovalError)
    expect(tx.user.update).not.toHaveBeenCalled()
  })

  it('demotes to USER when the account has no operator membership', async () => {
    const { service, tx } = makeHarness()

    await service.approve(APPROVER, 'ap-1')

    expect(tx.user.update.mock.calls[0][0].data).toMatchObject({ role: UserRole.USER })
  })

  /**
   * Demotion strips PLATFORM authority, not every authority. Writing USER flat over an
   * account that still administers an operator would put the global role and the membership
   * role out of sync until the next membership change silently corrected it.
   */
  it('falls back to the operator role the memberships already imply', async () => {
    const { service, tx } = makeHarness()
    tx.user.findFirst.mockResolvedValue({
      role: UserRole.SUPER_ADMIN,
      operatorMemberships: [{ role: OperatorMemberRole.ADMIN }],
    })

    await service.approve(APPROVER, 'ap-1')

    expect(tx.user.update.mock.calls[0][0].data).toMatchObject({
      role: UserRole.OPERATOR_ADMIN,
    })
  })

  it('revokes outstanding tokens, because the authority they were minted with is gone', async () => {
    const { service, tx } = makeHarness()

    await service.approve(APPROVER, 'ap-1')

    expect(tx.user.update.mock.calls[0][0].data.sessionsValidFrom).toBeInstanceOf(Date)
  })

  // Re-checked at redemption, not only at request: the tier can shrink inside the 24h window.
  it('re-checks the last-super-admin rule when the approval is redeemed', async () => {
    const { service, tx } = makeHarness()
    tx.user.count.mockResolvedValue(0)

    await expect(service.approve(APPROVER, 'ap-1')).rejects.toBeInstanceOf(LastSuperAdminError)
  })

  it('re-checks that the target is still a super admin', async () => {
    const { service, tx } = makeHarness()
    tx.user.findFirst.mockResolvedValue({ role: UserRole.USER, operatorMemberships: [] })

    await expect(service.approve(APPROVER, 'ap-1')).rejects.toBeInstanceOf(NotASuperAdminError)
  })

  it('loses the race rather than demoting twice when two approvers commit at once', async () => {
    const { service, tx } = makeHarness()
    tx.pendingApproval.updateMany.mockResolvedValue({ count: 0 })

    await expect(service.approve(APPROVER, 'ap-1')).rejects.toBeInstanceOf(ApprovalNotPendingError)
    expect(tx.user.update).not.toHaveBeenCalled()
  })

  it('audits the demotion against the account, carrying who asked', async () => {
    const { service, tx } = makeHarness()

    await service.approve(APPROVER, 'ap-1')

    const audit = tx.auditLog.create.mock.calls[0][0].data
    expect(audit).toMatchObject({
      action: 'user.demoted',
      entityType: 'User',
      entityId: TARGET,
      actorId: APPROVER.id,
    })
    expect(audit.payload).toMatchObject({ requestedBy: REQUESTER.id, from: UserRole.SUPER_ADMIN })
  })

  it('lets the requester withdraw their own request', async () => {
    const { service, tx } = makeHarness()

    const view = await service.reject(REQUESTER, 'ap-1', 'changed my mind')

    expect(view.status).toBe(ApprovalStatus.REJECTED)
    expect(tx.user.update).not.toHaveBeenCalled()
  })

  it('only lists and decides its own action, never a purge approval', async () => {
    const { service, prisma, tx } = makeHarness()
    tx.pendingApproval.findUnique.mockResolvedValue(approvalRow({ action: 'purge' }))

    await service.list(APPROVER)
    expect(prisma.pendingApproval.findMany.mock.calls[0][0].where).toMatchObject({
      action: DEMOTE_ACTION,
    })

    await expect(service.approve(APPROVER, 'ap-1')).rejects.toThrow()
    expect(tx.user.update).not.toHaveBeenCalled()
  })
})

describe('IdentityApprovalService — expiry', () => {
  it('burns a lapsed approval before opening the decision transaction', async () => {
    const { service, prisma } = makeHarness()

    await service.approve(APPROVER, 'ap-1').catch(() => undefined)

    // Marking it expired inside the transaction that then throws would roll the mark back
    // and the row would come back to life as PENDING on the next attempt.
    expect(prisma.pendingApproval.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'ap-1',
        status: ApprovalStatus.PENDING,
        expiresAt: { lte: expect.any(Date) },
      },
      data: { status: ApprovalStatus.EXPIRED },
    })
  })

  it('only offers approvals that have not lapsed', async () => {
    const { service, prisma } = makeHarness()

    await service.list(APPROVER)

    expect(prisma.pendingApproval.findMany.mock.calls[0][0].where).toMatchObject({
      status: ApprovalStatus.PENDING,
      expiresAt: { gt: expect.any(Date) },
    })
  })
})

describe('IdentityApprovalService — lifecycle filtering', () => {
  it('finds the target regardless of lifecycle status', async () => {
    const { service, prisma } = makeHarness()

    await service.requestDemotion(REQUESTER, TARGET, 'why')

    // Without naming lifecycleStatus the Prisma extension narrows to ACTIVE, and an
    // archived super admin would read back as absent — and so as unprotected.
    const where = prisma.user.findFirst.mock.calls[0][0].where as {
      lifecycleStatus: { in: LifecycleStatus[] }
    }
    expect(where.lifecycleStatus.in).toContain(LifecycleStatus.ARCHIVED)
  })
})
