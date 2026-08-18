import type { ConfigService } from '@nestjs/config'
import { OperatorMemberRole, OperatorStatus } from '@prisma/client'
import type { IAuthProvider } from '@spark/auth'
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
    deleteUser: jest.fn().mockResolvedValue(undefined),
  }

  const service = new OperatorRegistrationService(
    prisma as unknown as PrismaService,
    config as unknown as ConfigService,
    firebase as unknown as IAuthProvider,
  )
  return { service, prisma, tx, firebase, config }
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

  it('falls back to the business name when no display name is given', async () => {
    const { service, firebase } = makeHarness()

    await service.register(BODY)

    expect(firebase.signUp.mock.calls[0][0].displayName).toBe('New Parking Ltd')
  })

  it('refuses an address that already has an account, before provisioning', async () => {
    const { service, prisma, firebase } = makeHarness()
    prisma.user.findFirst.mockResolvedValue({ id: 'existing' })

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
