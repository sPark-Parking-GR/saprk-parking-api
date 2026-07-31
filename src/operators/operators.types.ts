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
}

export interface OperatorDetail extends OperatorSummary {
  facilities: OperatorFacilitySummary[]
  plans: OperatorPlanSummary[]
  members: OperatorMemberSummary[]
}
