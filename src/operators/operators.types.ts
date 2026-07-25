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
