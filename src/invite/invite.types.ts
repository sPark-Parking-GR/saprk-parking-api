import { DomainError } from '../common/errors/domain.errors'

export class InviteNotFoundError extends DomainError {
  constructor() {
    super('Invite not found')
  }
}

export class InviteExpiredError extends DomainError {
  constructor() {
    super('This invite has expired or is no longer valid')
  }
}

export class InviteAlreadyAcceptedError extends DomainError {
  constructor() {
    super('This invite has already been accepted')
  }
}

export class InviteNotRevocableError extends DomainError {
  constructor(status: string) {
    super(`Only a pending invite can be revoked; this one is ${status}`)
  }
}

export interface InviteSummary {
  id: string
  email: string
  businessName: string
  status: string
  expiresAt: Date
  createdAt: Date
  acceptedAt: Date | null
}

export interface InviteValidation {
  businessName: string
  email: string
  expired: boolean
}
