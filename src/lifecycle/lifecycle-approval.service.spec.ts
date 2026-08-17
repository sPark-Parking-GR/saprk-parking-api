import { ApprovalStatus, LifecycleStatus, UserRole } from '@prisma/client'
import type { AuthUser } from '@spark/types'
import {
  ApprovalAlreadyPendingError,
  ApprovalExpiredError,
  ApprovalNotFoundError,
  ApprovalNotPendingError,
  PurgeApproverUnavailableError,
  SelfApprovalError,
} from '../common/errors/domain.errors'
import type { PrismaService } from '../prisma/prisma.service'
import { APPROVAL_TTL_MS, LifecycleApprovalService } from './lifecycle-approval.service'

const REQUESTER: AuthUser = {
  id: 'admin-1',
  email: 'one@spark.invalid',
  role: 'platform_admin',
  emailVerified: true,
}

const APPROVER: AuthUser = {
  id: 'admin-2',
  email: 'two@spark.invalid',
  role: 'platform_admin',
  emailVerified: true,
}

type MockPrisma = {
  user: { count: jest.Mock }
  pendingApproval: {
    findFirst: jest.Mock
    findUnique: jest.Mock
    findMany: jest.Mock
    create: jest.Mock
    updateMany: jest.Mock
  }
  auditLog: { create: jest.Mock }
  $transaction: jest.Mock
}

function makePrisma(): MockPrisma {
  const prisma: MockPrisma = {
    // One other platform admin exists unless a test says otherwise.
    user: { count: jest.fn().mockResolvedValue(1) },
    pendingApproval: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(),
  }
  prisma.$transaction.mockImplementation(async (fn: (tx: MockPrisma) => Promise<unknown>) =>
    fn(prisma),
  )
  return prisma
}

function approvalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ap-1',
    action: 'purge',
    resourceType: 'facility',
    resourceId: 'f1',
    reason: 'GDPR erasure request 4471',
    requestedBy: REQUESTER.id,
    requestedByRole: REQUESTER.role,
    status: ApprovalStatus.PENDING,
    expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
    decidedBy: null,
    decidedByRole: null,
    decidedAt: null,
    decisionReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function makeService(prisma: MockPrisma): LifecycleApprovalService {
  return new LifecycleApprovalService(prisma as unknown as PrismaService)
}

describe('LifecycleApprovalService — requesting a purge', () => {
  it('fails closed when nobody else could ever approve it', async () => {
    const prisma = makePrisma()
    prisma.user.count.mockResolvedValue(0)

    await expect(
      makeService(prisma).request(REQUESTER, 'facility', 'f1', 'decommissioned'),
    ).rejects.toBeInstanceOf(PurgeApproverUnavailableError)

    expect(prisma.pendingApproval.create).not.toHaveBeenCalled()
    expect(prisma.auditLog.create).not.toHaveBeenCalled()
  })

  it('counts only live accounts that actually hold the purge permission', async () => {
    const prisma = makePrisma()
    prisma.pendingApproval.create.mockResolvedValue(approvalRow())

    await makeService(prisma).request(REQUESTER, 'facility', 'f1', 'decommissioned')

    // Both administrative roles hold platform:tenant.purge, and the approver set is derived
    // from the permission map rather than hardcoded — so a super admin counts as the second
    // pair of eyes for a platform admin's request, and vice versa.
    expect(prisma.user.count).toHaveBeenCalledWith({
      where: {
        id: { not: REQUESTER.id },
        role: { in: [UserRole.PLATFORM_ADMIN, UserRole.SUPER_ADMIN] },
        deletedAt: null,
        lifecycleStatus: LifecycleStatus.ACTIVE,
      },
    })
  })

  it('stamps a 24h expiry and audits the request with its reason', async () => {
    const prisma = makePrisma()
    prisma.pendingApproval.create.mockResolvedValue(approvalRow())
    const before = Date.now()

    const view = await makeService(prisma).request(REQUESTER, 'facility', 'f1', 'fraudulent lot')

    const created = prisma.pendingApproval.create.mock.calls[0][0].data as {
      expiresAt: Date
      reason: string
      requestedBy: string
    }
    expect(created.expiresAt.getTime() - before).toBeGreaterThanOrEqual(APPROVAL_TTL_MS - 1_000)
    expect(created.expiresAt.getTime() - before).toBeLessThanOrEqual(APPROVAL_TTL_MS + 60_000)
    expect(created.reason).toBe('fraudulent lot')
    expect(created.requestedBy).toBe(REQUESTER.id)
    expect(view.status).toBe(ApprovalStatus.PENDING)

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1)
    const audited = prisma.auditLog.create.mock.calls[0][0].data as {
      action: string
      entityType: string
      payload: { reason: string }
    }
    expect(audited.action).toBe('lifecycle.purge_requested')
    expect(audited.entityType).toBe('Facility')
    expect(audited.payload.reason).toBe('fraudulent lot')
  })

  it('lapses a stale request before checking, so a dead one cannot wedge the resource', async () => {
    const prisma = makePrisma()
    prisma.pendingApproval.create.mockResolvedValue(approvalRow())

    await makeService(prisma).request(REQUESTER, 'facility', 'f1', 'retry after expiry')

    const lapse = prisma.pendingApproval.updateMany.mock.calls[0][0] as {
      where: { expiresAt: { lte: Date } }
      data: { status: ApprovalStatus }
    }
    expect(lapse.where.expiresAt.lte).toBeInstanceOf(Date)
    expect(lapse.data.status).toBe(ApprovalStatus.EXPIRED)
  })

  it('refuses a second live request for the same resource', async () => {
    const prisma = makePrisma()
    prisma.pendingApproval.findFirst.mockResolvedValue({ id: 'ap-existing' })

    await expect(
      makeService(prisma).request(REQUESTER, 'facility', 'f1', 'again'),
    ).rejects.toBeInstanceOf(ApprovalAlreadyPendingError)
    expect(prisma.pendingApproval.create).not.toHaveBeenCalled()
  })
})

describe('LifecycleApprovalService — redeeming', () => {
  it('refuses the requester their own approval', async () => {
    const prisma = makePrisma()
    prisma.pendingApproval.findUnique.mockResolvedValue(approvalRow())

    await expect(makeService(prisma).claim(REQUESTER, 'ap-1')).rejects.toBeInstanceOf(
      SelfApprovalError,
    )
    // Only the (no-op) expiry burn ran; the approval was never claimed.
    expect(prisma.pendingApproval.updateMany).toHaveBeenCalledTimes(1)
    expect(prisma.pendingApproval.updateMany.mock.calls[0][0].data).toEqual({
      status: ApprovalStatus.EXPIRED,
    })
    expect(prisma.auditLog.create).not.toHaveBeenCalled()
  })

  it('burns a lapsed approval OUTSIDE the decision transaction, then refuses it', async () => {
    const prisma = makePrisma()
    prisma.pendingApproval.findUnique.mockResolvedValue(
      approvalRow({ status: ApprovalStatus.EXPIRED, expiresAt: new Date(Date.now() - 1_000) }),
    )

    await expect(makeService(prisma).claim(APPROVER, 'ap-1')).rejects.toBeInstanceOf(
      ApprovalExpiredError,
    )

    // The burn is the FIRST write and is not wrapped in $transaction: a mark rolled back by
    // the refusal that follows it would resurrect the approval as PENDING.
    expect(prisma.pendingApproval.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: 'ap-1',
        status: ApprovalStatus.PENDING,
        expiresAt: { lte: expect.any(Date) as unknown as Date },
      },
      data: { status: ApprovalStatus.EXPIRED },
    })
    expect(prisma.$transaction.mock.invocationCallOrder[0]).toBeGreaterThan(
      prisma.pendingApproval.updateMany.mock.invocationCallOrder[0]!,
    )
  })

  it('refuses an approval that was already decided', async () => {
    const prisma = makePrisma()
    prisma.pendingApproval.findUnique.mockResolvedValue(
      approvalRow({ status: ApprovalStatus.REJECTED }),
    )

    await expect(makeService(prisma).claim(APPROVER, 'ap-1')).rejects.toBeInstanceOf(
      ApprovalNotPendingError,
    )
  })

  it('reports an unknown approval as not found', async () => {
    const prisma = makePrisma()

    await expect(makeService(prisma).claim(APPROVER, 'nope')).rejects.toBeInstanceOf(
      ApprovalNotFoundError,
    )
  })

  it('claims with a state-guarded write and audits the approver, not the requester', async () => {
    const prisma = makePrisma()
    prisma.pendingApproval.findUnique.mockResolvedValue(approvalRow())

    const claimed = await makeService(prisma).claim(APPROVER, 'ap-1')

    expect(claimed.status).toBe(ApprovalStatus.APPROVED)
    expect(claimed.decidedBy).toBe(APPROVER.id)
    // Call 0 is the unconditional expiry burn; call 1 is the claim itself.
    const guard = prisma.pendingApproval.updateMany.mock.calls[1][0] as {
      where: { status: ApprovalStatus; expiresAt: { gt: Date } }
    }
    expect(guard.where.status).toBe(ApprovalStatus.PENDING)
    expect(guard.where.expiresAt.gt).toBeInstanceOf(Date)

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1)
    const audited = prisma.auditLog.create.mock.calls[0][0].data as {
      action: string
      actorId: string
      payload: { requestedBy: string; reason: string }
    }
    expect(audited.action).toBe('lifecycle.purge_approved')
    expect(audited.actorId).toBe(APPROVER.id)
    expect(audited.payload.requestedBy).toBe(REQUESTER.id)
    expect(audited.payload.reason).toBe('GDPR erasure request 4471')
  })

  it('treats a race that lost the guarded write as already decided', async () => {
    const prisma = makePrisma()
    prisma.pendingApproval.findUnique.mockResolvedValue(approvalRow())
    prisma.pendingApproval.updateMany.mockResolvedValue({ count: 0 })

    await expect(makeService(prisma).claim(APPROVER, 'ap-1')).rejects.toBeInstanceOf(
      ApprovalNotPendingError,
    )
  })

  it('lets the requester withdraw their own request by rejecting it', async () => {
    const prisma = makePrisma()
    prisma.pendingApproval.findUnique.mockResolvedValue(approvalRow())

    const view = await makeService(prisma).reject(REQUESTER, 'ap-1', 'raised in error')

    expect(view.status).toBe(ApprovalStatus.REJECTED)
    expect(view.decisionReason).toBe('raised in error')
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1)
    expect(prisma.auditLog.create.mock.calls[0][0].data.action).toBe('lifecycle.purge_rejected')
  })

  it('lists only live pending requests', async () => {
    const prisma = makePrisma()
    prisma.pendingApproval.findMany.mockResolvedValue([approvalRow()])

    const list = await makeService(prisma).list()

    expect(list.total).toBe(1)
    const where = prisma.pendingApproval.findMany.mock.calls[0][0].where as {
      status: ApprovalStatus
      expiresAt: { gt: Date }
    }
    expect(where.status).toBe(ApprovalStatus.PENDING)
    expect(where.expiresAt.gt).toBeInstanceOf(Date)
  })
})
