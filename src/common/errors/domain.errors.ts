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

export class InvalidTariffScheduleError extends DomainError {
  constructor(reason: string) {
    super(`Invalid tariff schedule: ${reason}`)
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

export class FacilityFieldForbiddenError extends DomainError {
  constructor(field: string) {
    super(`Field ${field} cannot be set by this role`)
  }
}
