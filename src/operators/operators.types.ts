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
