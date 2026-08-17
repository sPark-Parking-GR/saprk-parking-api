import type { LifecycleStatus, OperatorMemberRole, UserRole } from '@prisma/client'
import { DomainError } from '../common/errors/domain.errors'

export interface IdentityMembership {
  operatorId: string
  operatorName: string
  role: OperatorMemberRole
}

export interface IdentityUserSummary {
  id: string
  email: string
  displayName: string | null
  role: UserRole
  emailVerified: boolean
  lifecycleStatus: LifecycleStatus
  /**
   * Set by SELF-SERVICE deletion, which anonymises the row in place and can never be
   * undone. Deliberately separate from lifecycleStatus, which an administrator moves and
   * can move back: an account can be ARCHIVED and restorable, or anonymised and gone, and
   * conflating them would let someone try to restore an identity that no longer exists.
   */
  anonymisedAt: string | null
  createdAt: string
  memberships: IdentityMembership[]
}

export interface IdentityUserPage {
  items: IdentityUserSummary[]
  total: number
  skip: number
  take: number
}

export interface IdentityAuditEntry {
  id: string
  action: string
  actorId: string | null
  actorRole: string | null
  createdAt: string
}

export interface IdentityUserDetail extends IdentityUserSummary {
  updatedAt: string
  /** Tokens issued at or before this instant are refused. Moved by every lockout path. */
  sessionsValidFrom: string | null
  lifecycleChangedAt: string | null
  lifecycleChangedBy: string | null
  lifecycleReason: string | null
  purgeAfter: string | null
  recentActivity: IdentityAuditEntry[]
}

export interface IdentityApprovalView {
  id: string
  action: string
  resourceId: string
  reason: string
  requestedBy: string
  requestedByRole: string
  status: string
  expiresAt: string
  decidedBy: string | null
  decidedAt: string | null
  decisionReason: string | null
  createdAt: string
}

export interface IdentityApprovalList {
  items: IdentityApprovalView[]
  total: number
}

export class IdentityUserNotFoundError extends DomainError {
  constructor(userId: string) {
    super(`No user account ${userId} exists.`)
  }
}

export class SelfRoleAssignmentError extends DomainError {
  constructor() {
    super(
      'You cannot change your own platform role. Ask another super admin — a single ' +
        'compromised account must not be able to widen its own authority.',
    )
  }
}

export class AnonymisedAccountError extends DomainError {
  constructor() {
    super(
      'This account was deleted by its owner and anonymised in place. There is no identity ' +
        'left to re-role.',
    )
  }
}

/**
 * Names the escape hatch, because refusing without one reads as "this can never be undone".
 * Super admins are unreachable by the ordinary verbs on purpose; the demotion flow is how a
 * peer is acted on, and it needs a second super admin to agree.
 */
export class SuperAdminProtectedError extends DomainError {
  constructor(action: string) {
    super(
      `A super administrator cannot be ${action} directly. Demote the account first — that ` +
        'requires a second super admin to approve — after which it is an ordinary account.',
    )
  }
}

export class LastSuperAdminError extends DomainError {
  constructor() {
    super(
      'This is the last super administrator. Demoting it would leave nobody able to manage ' +
        'user accounts, and no one could restore the tier from inside the product. Promote ' +
        'another super admin first.',
    )
  }
}

export class NotASuperAdminError extends DomainError {
  constructor() {
    super('This account is not a super administrator, so there is nothing to demote.')
  }
}

/**
 * Fails closed on a deployment with one super admin, which is the situation the rule most
 * exists for: a single administrator who cannot be asked to agree with themselves.
 */
export class SuperAdminApproverUnavailableError extends DomainError {
  constructor() {
    super(
      'Demoting a super administrator needs a second super admin to approve it, and no ' +
        'other active super admin exists. Promote one first.',
    )
  }
}
