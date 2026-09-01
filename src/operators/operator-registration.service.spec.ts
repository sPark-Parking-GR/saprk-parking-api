import type { ConfigService } from '@nestjs/config'
import { OperatorMemberRole, OperatorStatus } from '@prisma/client'
import type { AuthContext } from '@spark/auth'
import { AccountLinkingService } from '../auth/account-linking.service'
import type { PrismaService } from '../prisma/prisma.service'
import { OperatorRegistrationService } from './operator-registration.service'
import { OperatorEmailTakenError, SelfSignupDisabledError } from './operators.types'

const BODY = {
  email: 'owner@newbusiness.invalid',
  password: 'a-strong-password',
  businessName: 'New Parking Ltd',
  displayName: undefined,
}

function makeHarness(enabled = true) {
  const tx = {
    parkingOperator: { create: jest.fn().mockResolvedValue({ id: 'op-new' }) },
    operatorMembership: { create: jest.fn().mockResolvedValue({}) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    user: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ role: 'USER', lifecycleStatus: 'ACTIVE', operatorMemberships: [] }),
      update: jest.fn().mockResolvedValue({}),
    },
    $executeRaw: jest.fn().mockResolvedValue(undefined),
  }
  const prisma = {
    $transaction: jest.fn(async (fn: (c: typeof tx) => unknown) => fn(tx)),
    user: { findFirst: jest.fn().mockResolvedValue(null) },
  }
  const config = {
    get: jest.fn().mockReturnValue(enabled ? 'true' : 'false'),
  }
  const firebase = {
    signUp: jest.fn().mockResolvedValue({ session: { user: { id: 'user-new' } } }),
    signIn: jest.fn().mockResolvedValue({ session: { user: { id: 'user-existing' } } }),
    deleteUser: jest.fn().mockResolvedValue(undefined),
  }
  const accountLinking = new AccountLinkingService(
    prisma as unknown as PrismaService,
    firebase as unknown as AuthContext,
  )

  const service = new OperatorRegistrationService(
    prisma as unknown as PrismaService,
    config as unknown as ConfigService,
    firebase as unknown as AuthContext,
    accountLinking,
  )
  return { service, prisma, tx, firebase, config }
}

function mockLinkable(prisma: ReturnType<typeof makeHarness>['prisma']) {
  prisma.user.findFirst.mockResolvedValue({
    id: 'user-existing',
    role: 'USER',
    lifecycleStatus: 'ACTIVE',
    operatorMemberships: [],
  })
}

describe('OperatorRegistrationService — the flag', () => {
  it('refuses while the platform is invite-only, before touching anything', async () => {
    const { service, firebase, prisma } = makeHarness(false)

    await expect(service.register(BODY)).rejects.toBeInstanceOf(SelfSignupDisabledError)
    expect(firebase.signUp).not.toHaveBeenCalled()
    expect(prisma.user.findFirst).not.toHaveBeenCalled()
  })

  it('reports its own state so the sign-up page can explain rather than fail on submit', () => {
    expect(makeHarness(true).service.isEnabled()).toBe(true)
    expect(makeHarness(false).service.isEnabled()).toBe(false)
  })
})

describe('OperatorRegistrationService — registering', () => {
  it('creates the business PENDING, not verified', async () => {
    const { service, tx } = makeHarness()

    await service.register(BODY)

    expect(tx.parkingOperator.create.mock.calls[0][0].data).toEqual({
      name: 'New Parking Ltd',
      status: OperatorStatus.PENDING,
    })
  })

  /**
   * They own the business they just registered, so the role is not what is withheld — the
   * operator's VERIFIED status is. Making them a lesser role instead would leave nobody able
   * to complete onboarding for their own company.
   */
  it('makes the registrant an operator admin of it', async () => {
    const { service, tx, firebase } = makeHarness()

    await service.register(BODY)

    expect(firebase.signUp.mock.calls[0][0].role).toBe('operator_admin')
    expect(tx.operatorMembership.create.mock.calls[0][0].data).toMatchObject({
      operatorId: 'op-new',
      userId: 'user-new',
      role: OperatorMemberRole.ADMIN,
      // Admins derive their scopes, so nothing is stored.
      scopes: [],
    })
  })

  it('records the registration against the new operator', async () => {
    const { service, tx } = makeHarness()

    await service.register(BODY)

    expect(tx.auditLog.create.mock.calls[0][0].data).toMatchObject({
      action: 'operator.self_registered',
      entityType: 'ParkingOperator',
      entityId: 'op-new',
      actorId: 'user-new',
    })
  })

  // The fallback was removed: displayName is the PERSON, and defaulting it to the company
  // put a business name in every list that names a human, with no way to correct it before
  // the profile page existed. Absent is honest — the UI renders the email instead.
  it('leaves the display name unset when none is given, rather than using the business name', async () => {
    const { service, firebase } = makeHarness()

    await service.register(BODY)

    expect(firebase.signUp.mock.calls[0][0].displayName).toBeUndefined()
  })

  it('uses the supplied personal name when one is given', async () => {
    const { service, firebase } = makeHarness()

    await service.register({ ...BODY, displayName: 'Real Person' })

    expect(firebase.signUp.mock.calls[0][0].displayName).toBe('Real Person')
  })

  it('refuses an address that already holds a privileged role, before provisioning', async () => {
    const { service, prisma, firebase } = makeHarness()
    prisma.user.findFirst.mockResolvedValue({
      id: 'existing',
      role: 'OPERATOR_ADMIN',
      lifecycleStatus: 'ACTIVE',
      operatorMemberships: [],
    })

    await expect(service.register(BODY)).rejects.toBeInstanceOf(OperatorEmailTakenError)
    expect(firebase.signUp).not.toHaveBeenCalled()
  })

  // An archived or anonymised account still owns its address.
  it('looks past the lifecycle filter when checking the address', async () => {
    const { service, prisma } = makeHarness()

    await service.register(BODY)

    const where = prisma.user.findFirst.mock.calls[0][0].where as Record<string, unknown>
    expect(where).toHaveProperty('lifecycleStatus')
  })

  /**
   * Firebase and Postgres cannot share a transaction. Without compensation the address ends
   * up taken by an account that owns nothing, and the person cannot retry with it.
   */
  it('deletes the new identity when the attachment transaction fails', async () => {
    const { service, tx, firebase } = makeHarness()
    tx.parkingOperator.create.mockRejectedValue(new Error('db down'))

    await expect(service.register(BODY)).rejects.toThrow('db down')
    expect(firebase.deleteUser).toHaveBeenCalledWith('user-new')
  })

  it('still surfaces the original failure when the compensating delete also fails', async () => {
    const { service, tx, firebase } = makeHarness()
    tx.parkingOperator.create.mockRejectedValue(new Error('db down'))
    firebase.deleteUser.mockRejectedValue(new Error('firebase down'))

    await expect(service.register(BODY)).rejects.toThrow('db down')
  })
})

describe('OperatorRegistrationService — linking an existing mobile account', () => {
  it('attaches the existing account instead of creating a new identity', async () => {
    const { service, prisma, firebase, tx } = makeHarness()
    mockLinkable(prisma)

    const result = await service.register(BODY)

    expect(result).toEqual({ linked: true })
    expect(firebase.signUp).not.toHaveBeenCalled()
    expect(firebase.signIn).toHaveBeenCalledWith({ email: BODY.email, password: BODY.password })
    expect(tx.operatorMembership.create.mock.calls[0][0].data).toMatchObject({
      userId: 'user-existing',
      role: OperatorMemberRole.ADMIN,
    })
  })

  it('bumps the role and the revocation watermark on the existing account', async () => {
    const { service, prisma, tx } = makeHarness()
    mockLinkable(prisma)

    await service.register(BODY)

    const data = tx.user.update.mock.calls[0][0].data
    expect(data.role).toBe('OPERATOR_ADMIN')
    expect(data.sessionsValidFrom).toBeInstanceOf(Date)
  })

  // The identity predates this request; an attach that fails must not destroy an account
  // that had nothing to do with the failure.
  it('does not delete the existing account if the attachment transaction fails', async () => {
    const { service, prisma, tx, firebase } = makeHarness()
    mockLinkable(prisma)
    tx.parkingOperator.create.mockRejectedValue(new Error('db down'))

    await expect(service.register(BODY)).rejects.toThrow('db down')
    expect(firebase.deleteUser).not.toHaveBeenCalled()
  })

  // Collapsed into the SAME error a genuinely-taken address gets: this is a public,
  // unauthenticated endpoint, and a distinguishable wrong-password response would tell a
  // credential-stuffing attacker which emails are low-privilege driver accounts ripe for
  // escalation, distinct from ones already spoken for.
  it('collapses a wrong password into the same error as an already-taken address, writing nothing', async () => {
    const { service, prisma, firebase, tx } = makeHarness()
    mockLinkable(prisma)
    firebase.signIn.mockRejectedValue(new Error('invalid credentials'))

    await expect(service.register(BODY)).rejects.toBeInstanceOf(OperatorEmailTakenError)
    expect(tx.operatorMembership.create).not.toHaveBeenCalled()
  })

  // Closes the TOCTOU window between resolve() and the transaction's own write: a second
  // concurrent request that already promoted this same row must not be allowed to attach
  // a second time.
  it('re-checks the row under lock and refuses if it changed since resolve()', async () => {
    const { service, prisma, tx } = makeHarness()
    mockLinkable(prisma)
    tx.user.findUnique.mockResolvedValue({
      role: 'OPERATOR_ADMIN',
      lifecycleStatus: 'ACTIVE',
      operatorMemberships: [],
    })

    await expect(service.register(BODY)).rejects.toBeInstanceOf(OperatorEmailTakenError)
  })

  // Defense-in-depth alongside the role check: today nothing creates an OperatorMembership
  // without also flipping role off USER in the same transaction, but the locked recheck
  // verifies the membership absence directly rather than relying on that as an invariant.
  it('re-checks under lock and refuses if a membership appeared even with role still USER', async () => {
    const { service, prisma, tx } = makeHarness()
    mockLinkable(prisma)
    tx.user.findUnique.mockResolvedValue({
      role: 'USER',
      lifecycleStatus: 'ACTIVE',
      operatorMemberships: [{ id: 'mem-1' }],
    })

    await expect(service.register(BODY)).rejects.toBeInstanceOf(OperatorEmailTakenError)
  })
})
