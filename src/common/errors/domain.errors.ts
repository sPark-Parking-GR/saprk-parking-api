export class DomainError extends Error {
  constructor(message: string) {
    super(message)
    this.name = this.constructor.name
  }
}

export class NoAvailabilityError extends DomainError {
  constructor(facilityId: string, startsAt: Date, endsAt: Date) {
    super(
      `No availability at facility ${facilityId} for ${startsAt.toISOString()} – ${endsAt.toISOString()}`,
    )
  }
}

export class QuoteExpiredError extends DomainError {
  constructor() {
    super('Price quote has expired. Request a new quote before proceeding.')
  }
}

export class BookingNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Booking ${id} not found`)
  }
}

// A scanned ticket resolves to no booking the caller may act on. Deliberately names
// neither the booking nor the credential: it is returned both when nothing matches and
// when the match belongs to another operator's facility, so the two are indistinguishable
// and ids cannot be probed — the same rule assertBookingAccess and transitionByOperator
// already apply. Echoing the presented code back would also put a live credential in logs.
export class TicketNotFoundError extends DomainError {
  constructor() {
    super('No booking matches this ticket')
  }
}

// The replay cache could not be reached, so a rotating code cannot be proven unused. See
// TicketService.claimNonce for why that refuses the scan instead of waving it through.
export class TicketVerificationUnavailableError extends DomainError {
  constructor() {
    super(
      'QR verification is temporarily unavailable. Check the booking in with the access code instead.',
    )
  }
}

export class TicketNotIssuableError extends DomainError {
  constructor() {
    super('This booking has no live ticket')
  }
}

// The scanned string is not a ticket this version can read at all. Distinct from
// TicketNotFoundError, which means the ticket parsed and matched nothing: this one is a
// bad request (400 via the DomainError fallback) and never touches the database.
export class MalformedTicketError extends DomainError {
  constructor() {
    super('This code is not a valid sPark ticket')
  }
}

export class BookingStatusTransitionError extends DomainError {
  constructor(from: string, to: string) {
    super(`Invalid booking status transition: ${from} → ${to}`)
  }
}

export class NoApplicableTariffError extends DomainError {
  constructor(facilityId: string) {
    super(`No applicable tariff rule found for facility ${facilityId}`)
  }
}

export class FacilityNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Facility ${id} not found or not available for booking`)
  }
}

// Facility exists but fails a hold-time eligibility check (inactive, unverified, or
// not a bookable kind) — a state conflict on a real resource, grouped with
// NoAvailabilityError rather than FacilityNotFoundError which means "no such id".
export class FacilityNotBookableError extends DomainError {
  constructor(facilityId: string) {
    super(`Facility ${facilityId} is not available for booking`)
  }
}

export class TariffPlanNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Tariff plan ${id} not found`)
  }
}

export class InvalidTariffScheduleError extends DomainError {
  constructor(reason: string) {
    super(`Invalid tariff schedule: ${reason}`)
  }
}

export class TariffAssignmentMismatchError extends DomainError {
  constructor(reason: string) {
    super(`Tariff assignment rejected: ${reason}`)
  }
}

export class DefaultTariffRequiredError extends DomainError {
  constructor() {
    super('Removing this default leaves active plans with no default. Choose a replacement.')
  }
}

// Thrown only after the refund intent (REFUND_PENDING + Refund row) is durably
// recorded, so the caller can safely retry cancelBooking to resume the refund.
export class RefundFailedError extends DomainError {
  constructor(bookingId: string) {
    super(
      `Refund for booking ${bookingId} could not be completed. The request is recorded and can be retried.`,
    )
  }
}

export class IdempotencyConflictError extends DomainError {
  constructor(key: string) {
    super(`A booking with idempotency key ${key} already exists`)
  }
}

export class OperatorContextRequiredError extends DomainError {
  constructor() {
    super('No operator context for this user')
  }
}

export class OperatorTargetRequiredError extends DomainError {
  constructor() {
    super('This account belongs to several operators. Set operatorId to choose one.')
  }
}

export class OperatorSuspendedError extends DomainError {
  constructor() {
    super('This operator account is suspended. Contact sPark support.')
  }
}

export class FacilityFieldForbiddenError extends DomainError {
  constructor(field: string) {
    super(`Field ${field} cannot be set by this role`)
  }
}

export class FacilityAlreadyExistsError extends DomainError {
  constructor(operatorId: string) {
    super(`Operator ${operatorId} already has a facility. Each operator may own only one.`)
  }
}

// Access codes carry 128 bits of entropy, so repeated collisions are not bad luck —
// they mean the generator or the uniqueness constraint is broken. Surfaced as a
// transient failure rather than a raw P2002 on a column no caller knows about.
export class AccessCodeGenerationError extends DomainError {
  constructor(attempts: number) {
    super(`Could not allocate a unique access code after ${attempts} attempts. Retry shortly.`)
  }
}

export class FacilityHasActiveBookingsError extends DomainError {
  constructor(facilityId: string, count: number) {
    super(
      `Facility ${facilityId} has ${count} booking(s) still to be honoured. Deactivate with force to cancel and refund them.`,
    )
  }
}

// A caller asked for a report on an operator they do not belong to. The message names no
// operator and reads the same whether or not the id exists, so the endpoint cannot be used
// to enumerate tenants.
export class AnalyticsScopeForbiddenError extends DomainError {
  constructor() {
    super('This account cannot report on the requested operator.')
  }
}

// Amounts are integer minor units of a currency, so summing across currencies produces a
// number that means nothing. The set is refused rather than silently added up; the caller
// has to narrow the range or the operator until one currency remains.
export class MixedCurrencyAnalyticsError extends DomainError {
  constructor(currencies: string[]) {
    super(
      `Cannot aggregate across currencies (${currencies.join(', ')}). Narrow the range or the operator.`,
    )
  }
}

// Some bookings were cancelled and refunded before another one failed, so the facility
// stays active on purpose: the caller must see that the shutdown is incomplete rather
// than find a deactivated facility with a booking nobody refunded. Retrying resumes —
// the bookings already cancelled no longer block.
export class FacilityDeactivationFailedError extends DomainError {
  constructor(facilityId: string, cancelled: number, failed: number) {
    super(
      `Facility ${facilityId} was not deactivated: ${cancelled} booking(s) cancelled and refunded, ${failed} failed. The facility stays active; retry to resume.`,
    )
  }
}

export class LifecycleResourceNotFoundError extends DomainError {
  constructor(resource: string, id: string) {
    super(`${resource} ${id} not found`)
  }
}

// The row exists but is not in a state the requested transition starts from (e.g.
// archiving something already tombstoned, or restoring something active).
export class LifecycleTransitionError extends DomainError {
  constructor(resource: string, id: string, from: string, requested: string) {
    super(`${resource} ${id} is ${from} and cannot be ${requested}`)
  }
}

// Restore would re-enter a uniqueness domain that filled up while the row was out of it
// (one facility per operator; one active default plan per operator). The message names
// the conflicting row so the caller can act, and the recreated partial unique indexes
// are the concurrency backstop behind this error — a raw P2002 is translated to it.
export class LifecycleRestoreConflictError extends DomainError {
  constructor(resource: string, id: string, conflict: string) {
    super(`Cannot restore ${resource} ${id}: ${conflict}`)
  }
}

// Archiving an operator while it still has lifecycle-active facilities would leave those
// facilities publicly visible under an operator that administratively no longer exists.
export class OperatorHasActiveFacilitiesError extends DomainError {
  constructor(operatorId: string, count: number) {
    super(
      `Operator ${operatorId} still has ${count} active facilit${count === 1 ? 'y' : 'ies'}. Archive them first.`,
    )
  }
}
