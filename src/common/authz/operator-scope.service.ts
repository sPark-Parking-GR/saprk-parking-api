import { Injectable } from '@nestjs/common'
import { isPlatformRole, type AuthUser } from '@spark/types'
import { PrismaService } from '../../prisma/prisma.service'
import {
  DomainError,
  OperatorContextRequiredError,
  OperatorTargetRequiredError,
} from '../errors/domain.errors'

export type OperatorScope = { kind: 'platform' } | { kind: 'operator'; operatorIds: string[] }

export type OperatorScopeWhere = { operatorId?: { in: string[] } }

/**
 * Visibility of one MANAGED resource (Facility, TariffPlan) for one caller: the operator
 * term AND, for everyone below platform admin, the per-user management assignment.
 *
 * Both keys are REQUIRED — `| undefined` rather than `?` — so `OperatorScopeWhere`, which
 * has only the operator term, is not assignable here. A facility or plan query that
 * reaches for the plain `scopeWhere` therefore fails to compile instead of silently
 * widening back to "everything this operator owns". Prisma treats an explicitly undefined
 * filter key as absent, so the value spreads into a `where` unchanged.
 */
export interface ManagedScopeWhere {
  operatorId: { in: string[] } | undefined
  managers: { some: { userId: string } } | undefined
}

/**
 * The single operator a create lands in. By default a platform admin must always name
 * one — every existing call site (tariff plans, operator-managed resources) keeps that
 * behavior and the non-nullable `string` return type unchanged. Only a caller that
 * passes `{ required: false }` (facility creation, where a platform admin may
 * deliberately leave a facility unassigned) gets `null` back instead of a thrown error.
 *
 * An operator caller with exactly one membership implies it (a stray body operatorId
 * stays ignored, as the DTOs document), but with several memberships there is no
 * implied tenant — the caller must name one they belong to, or the create is refused
 * rather than silently landing in an arbitrary operator. This part is unaffected by
 * `required`: an operator caller always resolves to a real operator or throws.
 */
export function targetOperatorId(scope: OperatorScope, requested: string | undefined): string
export function targetOperatorId(
  scope: OperatorScope,
  requested: string | undefined,
  options: { required: false },
): string | null
export function targetOperatorId(
  scope: OperatorScope,
  requested: string | undefined,
  options?: { required?: boolean },
): string | null {
  const required = options?.required ?? true

  if (scope.kind === 'platform') {
    if (!requested) {
      if (required) throw new DomainError('operatorId required')
      return null
    }
    return requested
  }

  if (requested !== undefined && scope.operatorIds.includes(requested)) return requested
  if (scope.operatorIds.length === 1) return scope.operatorIds[0]!

  throw new OperatorTargetRequiredError()
}

@Injectable()
export class OperatorScopeService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(user: AuthUser): Promise<OperatorScope> {
    // The whole administrative tier is unscoped. A super admin holds no OperatorMembership,
    // so falling through would raise OperatorContextRequiredError and refuse them on every
    // operator-scoped route in the API.
    if (isPlatformRole(user.role)) return { kind: 'platform' }

    if (user.role === 'operator_admin' || user.role === 'operator_staff') {
      // A user may belong to several operators; every one of them is in scope, so a
      // multi-operator caller can never be narrowed to an arbitrary single tenant.
      const memberships = await this.prisma.operatorMembership.findMany({
        where: { userId: user.id },
        select: { operatorId: true },
      })
      if (memberships.length === 0) throw new OperatorContextRequiredError()
      return { kind: 'operator', operatorIds: memberships.map((m) => m.operatorId) }
    }

    throw new OperatorContextRequiredError()
  }

  /**
   * Unmanaged operator scope. Still the right predicate for bookings, analytics, scan and
   * the audit log, whose visibility is a tenancy question and nothing else. Facility and
   * tariff-plan reads must NOT use it — see the two predicates below.
   */
  scopeWhere(scope: OperatorScope): OperatorScopeWhere {
    return scope.kind === 'platform' ? {} : { operatorId: { in: scope.operatorIds } }
  }

  facilityScopeWhere(scope: OperatorScope, user: AuthUser): ManagedScopeWhere {
    return managedScopeWhere(scope, user)
  }

  tariffPlanScopeWhere(scope: OperatorScope, user: AuthUser): ManagedScopeWhere {
    return managedScopeWhere(scope, user)
  }
}

/**
 * Platform callers get the operator term alone (theirs is empty — they see everything).
 * Everyone else — operator_admin and operator_staff alike — additionally has to hold a
 * management assignment on the row. Both relations are named `managers`, so one builder
 * serves both models; the two public methods stay separately named so a call site reads as
 * the resource it queries.
 */
function managedScopeWhere(scope: OperatorScope, user: AuthUser): ManagedScopeWhere {
  if (scope.kind === 'platform') return { operatorId: undefined, managers: undefined }
  return {
    operatorId: { in: scope.operatorIds },
    managers: { some: { userId: user.id } },
  }
}
