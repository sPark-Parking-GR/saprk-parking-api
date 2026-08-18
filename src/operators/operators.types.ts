import { DomainError } from '../common/errors/domain.errors'

export class OperatorNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Operator ${id} not found`)
  }
}

export class OperatorNotSuspendableError extends DomainError {
  constructor(status: string) {
    super(`Only a verified operator can be suspended; this one is ${status}`)
  }
}

export class OperatorNotReactivatableError extends DomainError {
  constructor(status: string) {
    super(`Only a suspended operator can be reactivated; this one is ${status}`)
  }
}

export class OperatorMemberNotFoundError extends DomainError {
  constructor(userId: string) {
    super(`User ${userId} is not a member of this operator`)
  }
}

// Names what breaks rather than just refusing: an operator with no admin cannot invite
// anyone, so the state is unrecoverable without platform intervention.
export class LastOperatorAdminError extends DomainError {
  constructor(operatorId: string) {
    super(
      `Operator ${operatorId} would be left with no administrator: nobody could manage its facilities, tariffs, staff or invites, and no one inside the business could restore access. Promote another member to admin first.`,
    )
  }
}

export class SelfRoleChangeError extends DomainError {
  constructor() {
    super('You cannot change your own operator role. Ask another admin of this operator.')
  }
}

export class SelfMembershipRemovalError extends DomainError {
  constructor() {
    super('You cannot remove your own operator membership. Ask another admin of this operator.')
  }
}

export interface OperatorSummary {
  id: string
  name: string
  status: string
  lifecycleStatus: string
  facilityCount: number
  memberCount: number
  createdAt: Date
}

export interface OperatorFacilitySummary {
  id: string
  name: string
  address: string
  isActive: boolean
  isVerified: boolean
  kind: string
}

export interface OperatorPlanSummary {
  id: string
  name: string
  isActive: boolean
  isDefault: boolean
}

export interface OperatorMemberSummary {
  userId: string
  email: string
  role: string
  createdAt: Date
  /** Effective, not stored: an ADMIN's set is derived, so this is what they may actually do. */
  scopes: readonly string[]
}

export interface OperatorDetail extends OperatorSummary {
  facilities: OperatorFacilitySummary[]
  plans: OperatorPlanSummary[]
  members: OperatorMemberSummary[]
}

/**
 * An administrator's scopes are derived, never stored, so there is nothing here to set. The
 * way to narrow what someone may do is to make them a staff member first.
 */
export class AdminScopesNotEditableError extends DomainError {
  constructor() {
    super(
      'An operator administrator holds every permission in their operator by definition. ' +
        'Change their role to staff first if their access should be narrowed.',
    )
  }
}

/**
 * Named rather than silent: an operator waiting on verification should be told that is what
 * is happening, not handed a generic refusal that reads like a bug in their own account.
 */
export class OperatorNotVerifiedError extends DomainError {
  constructor(status: string) {
    super(
      `This business is ${status.toLowerCase()} and has not been verified by sPark yet. ` +
        'Facilities can be published once verification completes.',
    )
  }
}

export class OperatorNotVerifiableError extends DomainError {
  constructor(status: string) {
    super(`Only a pending operator can be verified; this one is ${status.toLowerCase()}.`)
  }
}

/**
 * Refused because the platform has not opened registration yet, not because anything about
 * the request was wrong — so the message points at the invitation route rather than
 * suggesting the caller try again differently.
 */
export class SelfSignupDisabledError extends DomainError {
  constructor() {
    super(
      'sPark is not open for public operator registration yet. Ask an existing ' +
        'administrator for an invitation.',
    )
  }
}

export class OperatorEmailTakenError extends DomainError {
  constructor() {
    super('That email address already has a sPark account. Sign in instead.')
  }
}
