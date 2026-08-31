import { ForbiddenException } from '@nestjs/common'
import type { ConfigService } from '@nestjs/config'
import { InviteStatus } from '@prisma/client'
import type { AuthContext } from '@spark/auth'
import type { AuthUser } from '@spark/types'
import { InviteTokenService } from '../invite/invite-token.service'
import type { NotificationsService } from '../notifications/notifications.service'
import type { PrismaService } from '../prisma/prisma.service'
import { AdminInviteService } from './admin-invite.service'
import {
  AdminInviteAlreadyAcceptedError,
  AdminInviteEmailTakenError,
  AdminInviteExpiredError,
  AdminInviteNotFoundError,
} from './admin-invite.types'

const PLATFORM: AuthUser = {
  id: 'admin-1',
  email: 'admin@spark.invalid',
  role: 'platform_admin',
  emailVerified: true,
  displayName: 'Platform Admin',
}

const OPERATOR: AuthUser = {
  id: 'op-1',
  email: 'op@spark.invalid',
  role: 'operator_admin',
  emailVerified: true,
}

function inviteRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inv-1',
    email: 'newadmin@spark.invalid',
    displayName: 'New Admin',
    tokenHash: 'hashed',
    status: InviteStatus.PENDING,
    invitedById: PLATFORM.id,
    expiresAt: new Date(Date.now() + 60_000),
    acceptedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function makeHarness() {
  const tx = {
    platformAdminInvite: {
      create: jest.fn().mockResolvedValue(inviteRow()),
      update: jest.fn().mockResolvedValue(inviteRow()),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    user: { update: jest.fn().mockResolvedValue({}) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  }

  const prisma = {
    $transaction: jest.fn(async (fn: (c: typeof tx) => unknown) => fn(tx)),
    platformAdminInvite: {
      findUnique: jest.fn().mockResolvedValue(inviteRow()),
      findMany: jest.fn().mockResolvedValue([inviteRow()]),
      update: jest.fn().mockResolvedValue(inviteRow()),
    },
    user: { findFirst: jest.fn().mockResolvedValue(null) },
  }

  const notifications = { sendPlatformAdminInvite: jest.fn().mockResolvedValue(true) }
  const config = { getOrThrow: jest.fn().mockReturnValue('http://localhost:3000') }
  const firebase = {
    signUp: jest.fn().mockResolvedValue({ session: { user: { id: 'new-user-1' } } }),
    deleteUser: jest.fn().mockResolvedValue(undefined),
  }

  const service = new AdminInviteService(
    prisma as unknown as PrismaService,
    notifications as unknown as NotificationsService,
    new InviteTokenService(config as unknown as ConfigService),
    firebase as unknown as AuthContext,
  )

  return { service, prisma, tx, notifications, firebase }
}

describe('AdminInviteService — issuing', () => {
  it('refuses a caller without identity:admin.invite', async () => {
    const { service, tx } = makeHarness()

    await expect(
      service.create(OPERATOR, { email: 'x@spark.invalid', displayName: undefined }),
    ).rejects.toBeInstanceOf(ForbiddenException)
    expect(tx.platformAdminInvite.create).not.toHaveBeenCalled()
  })

  it('mails the link and reports whether it actually left', async () => {
    const { service, notifications } = makeHarness()

    const issued = await service.create(PLATFORM, {
      email: 'newadmin@spark.invalid',
      displayName: 'New Admin',
    })

    expect(issued.delivered).toBe(true)
    const sent = notifications.sendPlatformAdminInvite.mock.calls[0][0]
    expect(sent.to).toBe('newadmin@spark.invalid')
    expect(sent.acceptUrl).toContain('/invite/admin/accept/')
    // Named, so a recipient can sanity-check a platform-administration link against someone
    // they recognise before redeeming it.
    expect(sent.invitedByName).toBe('Platform Admin')
  })

  it('never puts the raw token anywhere but the email', async () => {
    const { service, tx, notifications } = makeHarness()

    const issued = await service.create(PLATFORM, {
      email: 'newadmin@spark.invalid',
      displayName: undefined,
    })

    const stored = tx.platformAdminInvite.create.mock.calls[0][0].data.tokenHash as string
    const mailed = notifications.sendPlatformAdminInvite.mock.calls[0][0].acceptUrl as string
    const rawToken = mailed.split('/').pop() as string

    expect(stored).not.toBe(rawToken)
    expect(stored).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(issued)).not.toContain(rawToken)
  })

  it('refuses an address that already has an account', async () => {
    const { service, prisma, tx } = makeHarness()
    prisma.user.findFirst.mockResolvedValue({ id: 'existing' })

    await expect(
      service.create(PLATFORM, { email: 'taken@spark.invalid', displayName: undefined }),
    ).rejects.toBeInstanceOf(AdminInviteEmailTakenError)
    expect(tx.platformAdminInvite.create).not.toHaveBeenCalled()
  })

  // An archived or anonymised account still owns its address; inviting over one would
  // collide on User.email at signUp with a far less clear failure.
  it('looks past the lifecycle filter when checking whether the address is free', async () => {
    const { service, prisma } = makeHarness()

    await service.create(PLATFORM, { email: 'x@spark.invalid', displayName: undefined })

    const where = prisma.user.findFirst.mock.calls[0][0].where as Record<string, unknown>
    expect(where).toHaveProperty('lifecycleStatus')
  })
})

describe('AdminInviteService — redeeming', () => {
  it('provisions exactly PLATFORM_ADMIN', async () => {
    const { service, firebase } = makeHarness()

    await service.accept('raw-token', 'a-strong-password')

    expect(firebase.signUp).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'newadmin@spark.invalid', role: 'platform_admin' }),
    )
  })

  /**
   * The tier is unreachable from any signup path by construction — SignUpData.role does not
   * admit it, so there is no value to pass. Asserted anyway: this is the property that would
   * matter most if the type ever widened.
   */
  it('never provisions a super admin', async () => {
    const { service, firebase } = makeHarness()

    await service.accept('raw-token', 'a-strong-password')

    expect(firebase.signUp.mock.calls[0][0].role).not.toBe('super_admin')
  })

  it('spends the invite conditionally on the token that was redeemed', async () => {
    const { service, tx } = makeHarness()

    await service.accept('raw-token', 'a-strong-password')

    // A revoke or resend landing mid-provision must beat this accept.
    expect(tx.platformAdminInvite.updateMany.mock.calls[0][0].where).toMatchObject({
      id: 'inv-1',
      tokenHash: 'hashed',
      status: InviteStatus.PENDING,
    })
  })

  it('marks the new account verified — the address proved itself by receiving the link', async () => {
    const { service, tx } = makeHarness()

    await service.accept('raw-token', 'a-strong-password')

    expect(tx.user.update.mock.calls[0][0].data).toMatchObject({ emailVerified: true })
  })

  it('refuses an unknown token', async () => {
    const { service, prisma, firebase } = makeHarness()
    prisma.platformAdminInvite.findUnique.mockResolvedValue(null)

    await expect(service.accept('nope', 'a-strong-password')).rejects.toBeInstanceOf(
      AdminInviteNotFoundError,
    )
    expect(firebase.signUp).not.toHaveBeenCalled()
  })

  it('refuses one already accepted', async () => {
    const { service, prisma, firebase } = makeHarness()
    prisma.platformAdminInvite.findUnique.mockResolvedValue(
      inviteRow({ status: InviteStatus.ACCEPTED }),
    )

    await expect(service.accept('raw-token', 'a-strong-password')).rejects.toBeInstanceOf(
      AdminInviteAlreadyAcceptedError,
    )
    expect(firebase.signUp).not.toHaveBeenCalled()
  })

  it('self-heals a lapsed PENDING invite to EXPIRED and refuses', async () => {
    const { service, prisma } = makeHarness()
    prisma.platformAdminInvite.findUnique.mockResolvedValue(
      inviteRow({ expiresAt: new Date(Date.now() - 1000) }),
    )

    await expect(service.accept('raw-token', 'a-strong-password')).rejects.toBeInstanceOf(
      AdminInviteExpiredError,
    )
    expect(prisma.platformAdminInvite.update.mock.calls[0][0].data).toMatchObject({
      status: InviteStatus.EXPIRED,
    })
  })

  it('refuses if the address signed up while the link was live', async () => {
    const { service, prisma, firebase } = makeHarness()
    prisma.user.findFirst.mockResolvedValue({ id: 'raced' })

    await expect(service.accept('raw-token', 'a-strong-password')).rejects.toBeInstanceOf(
      AdminInviteEmailTakenError,
    )
    expect(firebase.signUp).not.toHaveBeenCalled()
  })

  /**
   * Firebase and Postgres cannot share one transaction, so a failure after the identity
   * exists must be compensated — otherwise an orphaned platform admin is left behind with
   * no invite to account for it, which is worse than a failed invitation.
   */
  it('deletes the new identity when the attachment transaction fails', async () => {
    const { service, prisma, tx, firebase } = makeHarness()
    tx.platformAdminInvite.updateMany.mockResolvedValue({ count: 0 })

    await expect(service.accept('raw-token', 'a-strong-password')).rejects.toBeInstanceOf(
      AdminInviteExpiredError,
    )
    expect(firebase.deleteUser).toHaveBeenCalledWith('new-user-1')
    expect(prisma.$transaction).toHaveBeenCalled()
  })

  it('still surfaces the original failure when the compensating delete also fails', async () => {
    const { service, tx, firebase } = makeHarness()
    tx.platformAdminInvite.updateMany.mockResolvedValue({ count: 0 })
    firebase.deleteUser.mockRejectedValue(new Error('firebase down'))

    await expect(service.accept('raw-token', 'a-strong-password')).rejects.toBeInstanceOf(
      AdminInviteExpiredError,
    )
  })
})

describe('AdminInviteService — listing', () => {
  it('scopes a platform admin to their own invites', async () => {
    const { service, prisma } = makeHarness()

    await service.list(PLATFORM)

    // Without this a platform admin could read a roster of administrator addresses, which
    // is exactly what withholding identity:user.read is meant to prevent.
    expect(prisma.platformAdminInvite.findMany.mock.calls[0][0].where).toEqual({
      invitedById: PLATFORM.id,
    })
  })

  it('shows a super admin every invite, since they may read accounts anyway', async () => {
    const { service, prisma } = makeHarness()

    await service.list({ ...PLATFORM, role: 'super_admin' })

    expect(prisma.platformAdminInvite.findMany.mock.calls[0][0].where).toEqual({})
  })
})
