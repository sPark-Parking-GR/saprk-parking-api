import type { AuthUser } from '@spark/types'
import {
  OperatorScopeService,
  type ManagedScopeWhere,
  type OperatorScope,
  type OperatorScopeWhere,
} from './operator-scope.service'
import type { PrismaService } from '../../prisma/prisma.service'

const staff: AuthUser = {
  id: 'u-staff',
  email: 'staff@spark.gr',
  role: 'operator_staff',
  emailVerified: true,
}

const operatorAdmin: AuthUser = {
  id: 'u-admin',
  email: 'admin@biz.gr',
  role: 'operator_admin',
  emailVerified: true,
}

const platformAdmin: AuthUser = {
  id: 'u-platform',
  email: 'pa@spark.gr',
  role: 'platform_admin',
  emailVerified: true,
}

const PLATFORM: OperatorScope = { kind: 'platform' }
const ONE_OPERATOR: OperatorScope = { kind: 'operator', operatorIds: ['op1'] }
const TWO_OPERATORS: OperatorScope = { kind: 'operator', operatorIds: ['op1', 'op2'] }

describe('OperatorScopeService managed predicates', () => {
  const service = new OperatorScopeService({} as unknown as PrismaService)

  describe('facilityScopeWhere', () => {
    it('leaves a platform caller unnarrowed on both terms', () => {
      expect(service.facilityScopeWhere(PLATFORM, platformAdmin)).toEqual({
        operatorId: undefined,
        managers: undefined,
      })
    })

    it('carries the operator term AND the manager term for an operator admin', () => {
      expect(service.facilityScopeWhere(ONE_OPERATOR, operatorAdmin)).toEqual({
        operatorId: { in: ['op1'] },
        managers: { some: { userId: operatorAdmin.id } },
      })
    })

    // The narrowing is layered on top of the operator scope, never instead of it: a manager
    // row for a facility outside the caller's memberships must still be invisible.
    it('keeps every membership in the operator term for a multi-operator caller', () => {
      expect(service.facilityScopeWhere(TWO_OPERATORS, staff)).toEqual({
        operatorId: { in: ['op1', 'op2'] },
        managers: { some: { userId: staff.id } },
      })
    })

    it('narrows operator_staff exactly as it narrows operator_admin', () => {
      const asStaff = service.facilityScopeWhere(ONE_OPERATOR, { ...staff, id: 'same' })
      const asAdmin = service.facilityScopeWhere(ONE_OPERATOR, { ...operatorAdmin, id: 'same' })

      expect(asStaff).toEqual(asAdmin)
    })
  })

  describe('tariffPlanScopeWhere', () => {
    it('leaves a platform caller unnarrowed', () => {
      expect(service.tariffPlanScopeWhere(PLATFORM, platformAdmin)).toEqual({
        operatorId: undefined,
        managers: undefined,
      })
    })

    it('narrows an operator caller to the plans assigned to them', () => {
      expect(service.tariffPlanScopeWhere(ONE_OPERATOR, staff)).toEqual({
        operatorId: { in: ['op1'] },
        managers: { some: { userId: staff.id } },
      })
    })
  })

  describe('scopeWhere stays the unmanaged predicate', () => {
    // Bookings, analytics, scan and the audit log all read through this one. Narrowing it
    // would silently change four surfaces this feature deliberately does not touch.
    it('returns the operator term alone, with no manager key at all', () => {
      expect(service.scopeWhere(ONE_OPERATOR)).toEqual({ operatorId: { in: ['op1'] } })
      expect(service.scopeWhere(PLATFORM)).toEqual({})
    })

    it('is not assignable where a managed predicate is required', () => {
      const unmanaged: OperatorScopeWhere = service.scopeWhere(ONE_OPERATOR)

      // The guard rail itself: `managers` is a required key on ManagedScopeWhere, so a
      // facility or plan query that reached for the plain operator scope would not compile.
      // @ts-expect-error - OperatorScopeWhere is missing the `managers` term
      const narrowed: ManagedScopeWhere = unmanaged

      expect(narrowed).toBeDefined()
    })
  })
})
