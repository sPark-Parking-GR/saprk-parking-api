import type { InviteStatus } from '@prisma/client'
import { DomainError } from '../common/errors/domain.errors'

export interface AdminInviteSummary {
  id: string
  email: string
  displayName: string | null
  status: InviteStatus
  invitedById: string
  expiresAt: string
  acceptedAt: string | null
  createdAt: string
}

export interface AdminInviteIssued extends AdminInviteSummary {
  /** Whether the email carrying the only copy of the token actually left the building. */
  delivered: boolean
}

export interface AdminInviteValidation {
  email: string
  expired: boolean
}

export class AdminInviteNotFoundError extends DomainError {
  constructor() {
    super('That invitation link is not valid.')
  }
}

export class AdminInviteExpiredError extends DomainError {
  constructor() {
    super('That invitation has expired or been revoked. Ask for a new one.')
  }
}

export class AdminInviteAlreadyAcceptedError extends DomainError {
  constructor() {
    super('That invitation has already been used.')
  }
}

export class AdminInviteNotResendableError extends DomainError {
  constructor(status: InviteStatus) {
    super(`An invitation that is ${status} cannot be resent.`)
  }
}

export class AdminInviteNotRevocableError extends DomainError {
  constructor(status: InviteStatus) {
    super(`An invitation that is ${status} cannot be revoked.`)
  }
}

/**
 * The address already belongs to someone. Refused rather than silently upgrading them,
 * for the same reason the bootstrap CLI refuses: promoting an existing account is a
 * privilege escalation and must never be a side effect of redeeming a link.
 */
export class AdminInviteEmailTakenError extends DomainError {
  constructor(email: string) {
    super(
      `${email} already has a sPark account. Granting it platform administration is a role ` +
        'change on an existing account, which a super admin does deliberately — not ' +
        'something an invitation may do as a side effect.',
    )
  }
}
