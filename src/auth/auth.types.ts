import { DomainError } from '../common/errors/domain.errors'

// Deliberately one error for unknown, expired and already-used tokens alike. Telling the
// two apart would turn the reset endpoint into an oracle that confirms which guessed
// tokens were ever real. Falls through to the filter's generic DomainError → 400.
export class InvalidResetTokenError extends DomainError {
  constructor() {
    super('This password reset link is invalid or has expired. Request a new one.')
  }
}

// Deletion is refused, never forced: the account still has money or a parking space
// riding on it, and anonymising it would strand a stay the operator is holding open or a
// refund with nobody left to pay. The user settles those first — every one of them is
// cancellable from the app — and the deletion then goes through unblocked.
export class AccountHasUnsettledBookingsError extends DomainError {
  constructor(count: number) {
    super(
      `This account has ${count} booking(s) still in progress. Cancel or complete them before deleting the account.`,
    )
  }
}
