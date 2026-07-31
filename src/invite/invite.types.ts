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

// A lapsed invite IS resendable — reissuing it is the whole point — so only the two
// terminal states are refused.
export class InviteNotResendableError extends DomainError {
  constructor(status: string) {
    super(`An invite that is ${status} cannot be resent; issue a new one instead`)
  }
}

export interface InviteSummary {
  id: string
  email: string
  businessName: string
  status: string
  kind: string
  role: string
  operatorId: string | null
  expiresAt: Date
  createdAt: Date
  acceptedAt: Date | null
}

// create/resend additionally report whether the email carrying the raw token actually
// went out, because that token has no other exit from the system.
export interface InviteIssued extends InviteSummary {
  delivered: boolean
}

export interface InviteValidation {
  businessName: string
  email: string
  role: string
  expired: boolean
}
