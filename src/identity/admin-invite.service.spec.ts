import { ForbiddenException } from '@nestjs/common'
import type { ConfigService } from '@nestjs/config'
import { InviteStatus } from '@prisma/client'
import type { AuthContext } from '@spark/auth'
import type { AuthUser } from '@spark/types'
import { AccountLinkingService } from '../auth/account-linking.service'
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
      // Nothing to supersede unless a test says otherwise.
      findMany: jest.fn().mockResolvedValue([]),
    },
    user: {
      update: jest.fn().mockResolvedValue({}),
      findUnique: jest
        .fn()
        .mockResolvedValue({ role: 'USER', lifecycleStatus: 'ACTIVE', operatorMemberships: [] }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    $executeRaw: jest.fn().mockResolvedValue(undefined),
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
    signIn: jest.fn().mockResolvedValue({ session: { user: { id: 'user-existing' } } }),
    deleteUser: jest.fn().mockResolvedValue(undefined),
  }
  const accountLinking = new AccountLinkingService(
    prisma as unknown as PrismaService,
    firebase as unknown as AuthContext,
  )

  const service = new AdminInviteService(
    prisma as unknown as PrismaService,
    notifications as unknown as NotificationsService,
    new InviteTokenService(config as unknown as ConfigService),
    firebase as unknown as AuthContext,
    accountLinking,
  )

  return { service, prisma, tx, notifications, firebase }
}

function mockLinkable(prisma: ReturnType<typeof makeHarness>['prisma']): void {
  prisma.user.findFirst.mockResolvedValue({
    id: 'user-existing',
    role: 'USER',
    lifecycleStatus: 'ACTIVE',
    operatorMemberships: [],
  })
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

  // Issuance never needs ownership proof, only redemption does — the account that will
  // eventually attach is whoever proves they own it by signing in with its password.
  it('does not refuse issuance to a mobile-only account — only genuinely-taken ones', async () => {
    const { service, prisma, tx } = makeHarness()
    mockLinkable(prisma)

    await expect(
      service.create(PLATFORM, { email: 'driver@spark.invalid', displayName: undefined }),
    ).resolves.toBeDefined()
    expect(tx.platformAdminInvite.create).toHaveBeenCalled()
  })

  // Without this, revoking the invite an admin can see in the UI does not actually
  // withdraw platform_admin from that address if a different admin also invited it.
  it('retires an earlier live invite to the same address when a replacement is issued', async () => {
    const { service, tx } = makeHarness()
    tx.platformAdminInvite.findMany.mockResolvedValue([{ id: 'inv-old' }])

    await service.create(PLATFORM, { email: 'x@spark.invalid', displayName: undefined })

    expect(tx.platformAdminInvite.findMany.mock.calls[0][0]).toMatchObject({
      where: { email: 'x@spark.invalid', status: InviteStatus.PENDING },
    })
    expect(tx.platformAdminInvite.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['inv-old'] }, status: InviteStatus.PENDING },
      data: { status: InviteStatus.REVOKED },
    })
  })

  it('touches nothing when the address has no live invite', async () => {
    const { service, tx } = makeHarness()

    await service.create(PLATFORM, { email: 'x@spark.invalid', displayName: undefined })

    expect(tx.platformAdminInvite.updateMany).not.toHaveBeenCalled()
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

  describe('redeeming into an existing mobile-only account', () => {
    it('attaches the existing account instead of creating a new identity', async () => {
      const { service, prisma, firebase, tx } = makeHarness()
      mockLinkable(prisma)

      const result = await service.accept('raw-token', 'a-strong-password')

      expect(result).toEqual({ linked: true })
      expect(firebase.signUp).not.toHaveBeenCalled()
      expect(firebase.signIn).toHaveBeenCalledWith({
        email: 'newadmin@spark.invalid',
        password: 'a-strong-password',
      })
      expect(tx.user.update).toHaveBeenCalledWith({
        where: { id: 'user-existing' },
        data: {
          emailVerified: true,
          role: 'PLATFORM_ADMIN',
          sessionsValidFrom: expect.any(Date),
        },
      })
    })

    // The identity predates this request; an attach that fails must not destroy an
    // account that had nothing to do with the failure.
    it('does not delete the existing account if the attachment transaction fails', async () => {
      const { service, prisma, tx, firebase } = makeHarness()
      mockLinkable(prisma)
      tx.platformAdminInvite.updateMany.mockResolvedValue({ count: 0 })

      await expect(service.accept('raw-token', 'a-strong-password')).rejects.toBeInstanceOf(
        AdminInviteExpiredError,
      )
      expect(firebase.deleteUser).not.toHaveBeenCalled()
    })

    // Collapsed into the SAME error a genuinely-taken address gets: this is the
    // platform's most-privileged tier, and a distinguishable wrong-password response
    // would tell an attacker holding the invite token which emails are low-privilege
    // driver accounts ripe for escalation to platform_admin.
    it('collapses a wrong password into the same error as an already-taken address, writing nothing', async () => {
      const { service, prisma, firebase, tx } = makeHarness()
      mockLinkable(prisma)
      firebase.signIn.mockRejectedValue(new Error('invalid credentials'))

      await expect(service.accept('raw-token', 'a-strong-password')).rejects.toBeInstanceOf(
        AdminInviteEmailTakenError,
      )
      expect(tx.user.update).not.toHaveBeenCalled()
    })

    // Closes the TOCTOU window between resolve() and the transaction's own write.
    it('re-checks the row under lock and refuses if it changed since resolve()', async () => {
      const { service, prisma, tx } = makeHarness()
      mockLinkable(prisma)
      tx.user.findUnique.mockResolvedValue({
        role: 'PLATFORM_ADMIN',
        lifecycleStatus: 'ACTIVE',
        operatorMemberships: [],
      })

      await expect(service.accept('raw-token', 'a-strong-password')).rejects.toBeInstanceOf(
        AdminInviteEmailTakenError,
      )
    })

    // Defense-in-depth alongside the role check: nothing today creates an
    // OperatorMembership without also flipping role off USER in the same transaction,
    // but the locked recheck verifies membership absence directly rather than relying
    // on that as an invariant.
    it('re-checks under lock and refuses if a membership appeared even with role still USER', async () => {
      const { service, prisma, tx } = makeHarness()
      mockLinkable(prisma)
      tx.user.findUnique.mockResolvedValue({
        role: 'USER',
        lifecycleStatus: 'ACTIVE',
        operatorMemberships: [{ id: 'mem-1' }],
      })

      await expect(service.accept('raw-token', 'a-strong-password')).rejects.toBeInstanceOf(
        AdminInviteEmailTakenError,
      )
    })
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
