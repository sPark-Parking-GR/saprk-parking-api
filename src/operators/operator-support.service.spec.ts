import { ForbiddenException } from '@nestjs/common'
import type { AuthUser } from '@spark/types'
import type { PrismaService } from '../prisma/prisma.service'
import type { EntitlementService } from '../subscriptions/entitlement.service'
import type { OperatorAccessService } from './operator-access.service'
import { OperatorSupportService } from './operator-support.service'
import { OperatorNotFoundError } from './operators.types'

const operatorAdmin = {
  id: 'op-1',
  email: 'owner@biz.gr',
  role: 'operator_admin',
  emailVerified: true,
} as AuthUser

function setup(priority: boolean, assertScope = jest.fn().mockResolvedValue(undefined)) {
  const prisma = {
    parkingOperator: { findUnique: jest.fn().mockResolvedValue({ id: 'op-a' }) },
  }
  const access = { assertScope }
  const entitlements = { hasFeature: jest.fn().mockResolvedValue(priority) }
  const service = new OperatorSupportService(
    prisma as unknown as PrismaService,
    access as unknown as OperatorAccessService,
    entitlements as unknown as EntitlementService,
  )
  return { prisma, access, entitlements, service }
}

describe('OperatorSupportService', () => {
  it('reports priority for a plan that includes support.priority', async () => {
    const { service, entitlements } = setup(true)

    await expect(service.supportTier(operatorAdmin, 'op-a')).resolves.toEqual({
      operatorId: 'op-a',
      priority: true,
    })
    expect(entitlements.hasFeature).toHaveBeenCalledWith('op-a', 'support.priority')
  })

  // Absence of the feature is an answer, not a refusal: every tenant gets support, the flag
  // only says which queue routes them.
  it('reports non-priority rather than refusing when the plan omits it', async () => {
    const { service } = setup(false)

    await expect(service.supportTier(operatorAdmin, 'op-a')).resolves.toEqual({
      operatorId: 'op-a',
      priority: false,
    })
  })

  it('re-checks the billing scope in the service layer', async () => {
    const assertScope = jest.fn().mockRejectedValue(new ForbiddenException())
    const { service, entitlements } = setup(true, assertScope)

    await expect(service.supportTier(operatorAdmin, 'op-a')).rejects.toBeInstanceOf(
      ForbiddenException,
    )
    expect(assertScope).toHaveBeenCalledWith(operatorAdmin, 'op-a', 'org:billing.view')
    expect(entitlements.hasFeature).not.toHaveBeenCalled()
  })

  // A platform caller holds no memberships, so assertScope waves them through and cannot
  // notice that the id addresses nothing. Without the lookup the endpoint would report an
  // invented tenant as a real non-priority one.
  it('reports an unknown operator as not found rather than resolving a default plan', async () => {
    const { service, prisma, entitlements } = setup(false)
    prisma.parkingOperator.findUnique.mockResolvedValue(null)

    await expect(service.supportTier(operatorAdmin, 'ghost')).rejects.toBeInstanceOf(
      OperatorNotFoundError,
    )
    expect(entitlements.hasFeature).not.toHaveBeenCalled()
  })
})
