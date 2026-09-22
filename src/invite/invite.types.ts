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

/**
 * Refused at ISSUE as well as at redeem. Discovered only at redeem, the collision surfaces
 * after the mail went out and after a shell operator was created, to a person who has
 * already typed a password and cannot act on it — the inviting admin is the one who can.
 */
export class InviteEmailTakenError extends DomainError {
  constructor(email: string) {
    super(
      `${email} already has a sPark account. Attaching it to an operator is a change to ` +
        'that existing account, not something an invitation may do as a side effect.',
    )
  }
}

export class InviteNotRevocableError extends DomainError {
  constructor(status: string) {
    super(`Only a pending invite can be revoked; this one is ${status}`)
  }
}

// ONBOARDING no longer collects a business name at issue time — the invitee sets it
// alongside their password. MEMBER never sends one; the operator it attaches to already
// has a name, so this only fires on the flow that actually needs it.
export class InviteBusinessNameRequiredError extends DomainError {
  constructor() {
    super('Business name is required to complete onboarding')
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
  kind: string
  expired: boolean
  // Distinguishes the two ways a link stops working, which `expired` alone collapses into
  // one: a redeemed invite means the account exists and the person should sign in, while a
  // lapsed or revoked one means they need a new invite. Telling a returning operator their
  // link "expired" sends them back to the admin for a replacement they do not need.
  alreadyAccepted: boolean
  // True when the invited address already has a mobile-only account: accepting attaches
  // this invite's role to that account instead of creating a new one, so the accept form
  // must collect the EXISTING password rather than let the person choose a new one.
  requiresExistingPassword: boolean
}
