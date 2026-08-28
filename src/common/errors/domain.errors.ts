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

// A quota refusal, replacing the hardcoded one-facility-per-operator cap. Names the limit
// and the number in use rather than saying "limit reached": the caller cannot tell an
// upgrade from a cleanup without both, and a refusal with no number is a support ticket.
// `resource` is already plural ("facilities") — quotas are never expressed as one.
export class EntitlementLimitExceededError extends DomainError {
  constructor(
    readonly resource: string,
    readonly limit: number,
    readonly current: number,
  ) {
    super(
      `This operator's plan allows ${limit} ${resource} and ${current} are already in use. Upgrade the plan or remove one first.`,
    )
  }
}

// The other half of EntitlementLimitExceededError: the plan does not include the capability
// AT ALL, as opposed to including it and having none left. Naming the feature is what lets a
// surface render "upgrade to unlock this" instead of a bare refusal, and is why the two are
// separate errors rather than one message the client has to parse.
export class SubscriptionFeatureRequiredError extends DomainError {
  constructor(readonly feature: string) {
    super(`This operator's plan does not include "${feature}". Upgrade the plan to unlock it.`)
  }
}

// One limit a target plan would already be violating. `remove` is the count that has to go,
// precomputed so neither the client nor the operator has to do the subtraction.
export interface EntitlementViolation {
  resource: string
  limit: number
  current: number
  remove: number
}

// A plan change that would leave the operator over quota the moment it applied. Refused
// outright rather than enforced: silently deleting a customer's facilities to fit a
// cheaper plan destroys data they are still paying to hold, and admitting the change and
// leaving them over quota produces a tenant that no later create can ever unblock and no
// screen explains. Carries every violation, not the first, so one round trip tells them
// the whole cleanup.
export class SubscriptionDowngradeBlockedError extends DomainError {
  constructor(readonly violations: ReadonlyArray<EntitlementViolation>) {
    super(
      `Cannot apply this plan: ${violations
        .map(
          (v) =>
            `${v.current} ${v.resource} exceed the plan limit of ${v.limit} — remove ${v.remove} first`,
        )
        .join('; ')}`,
    )
  }
}

export class SubscriptionPlanNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Subscription plan ${id} not found`)
  }
}

// An override is a deviation FROM an agreement, so there has to be one to amend. Separate
// from SubscriptionPlanNotFoundError, which names a CATALOG row: reporting this as a missing
// plan printed the subscriber's id where a plan id was expected and told the operator to go
// looking for a plan that was never the problem.
export class LiveSubscriptionNotFoundError extends DomainError {
  constructor(subscriberId: string) {
    super(`${subscriberId} has no live subscription to override. Assign a plan first.`)
  }
}

// A rider holds at most one live subscription, so buying the plan they are already on has no
// meaning beyond opening a second provider subscription that bills the same card for the same
// thing. Named specifically rather than reported as a generic conflict: the rider needs to be
// told they already have it, not that something went wrong.
export class AlreadySubscribedToPlanError extends DomainError {
  constructor(code: string) {
    super(`You are already subscribed to "${code}".`)
  }
}

export class SubscriptionPlanCodeTakenError extends DomainError {
  constructor(code: string) {
    super(`A subscription plan with code "${code}" already exists`)
  }
}

// Archival is the only way to retire a plan, and it must not strand the agreements that
// point at it — the FK is ON DELETE RESTRICT for the same reason.
export class SubscriptionPlanInUseError extends DomainError {
  constructor(code: string, subscribers: number) {
    super(
      `Plan "${code}" still has ${subscribers} live subscription(s). Move them to another plan first.`,
    )
  }
}

// Fail closed on a misconfigured catalog. Every operator without an explicit subscription
// resolves to the default plan, so if that row is missing or archived, the honest answer is
// that entitlements cannot be determined — not that the operator has none (which would
// block every tenant) and not that they are unlimited (which would sell the platform away).
export class DefaultSubscriptionPlanMissingError extends DomainError {
  constructor(code: string) {
    super(
      `The default subscription plan "${code}" is missing or archived, so entitlements cannot be resolved. Restore it in the plan catalog.`,
    )
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

// Only a BUSINESS facility can be quoted or booked, so moving one out of that kind
// strands whatever is already sold there. No force twin of the delete path: the facility
// keeps operating and there is nothing to refund against, so the count is the whole
// remedy — wait the stays out, or cancel them through the delete flow.
export class FacilityKindChangeBlockedError extends DomainError {
  constructor(facilityId: string, kind: string, count: number) {
    super(
      `Facility ${facilityId} cannot become ${kind} while ${count} booking(s) are still to be honoured. Wait until they end, or cancel and refund them first.`,
    )
  }
}

// An operator-less facility has no owning operator to draw ADMIN members from, so there
// is no operator scope to authorize a manager assignment against. Distinct from
// FacilityNotFoundError: the resource exists, it just cannot have managers yet.
export class FacilityHasNoOperatorError extends DomainError {
  constructor(facilityId: string) {
    super(`Facility ${facilityId} has no operator assigned yet and cannot have managers`)
  }
}

// One or more requested manager ids cannot hold the assignment. The WHOLE request is
// refused and the offending ids are named: silently dropping them would report a grant
// that did not happen, and the caller already supplied these ids for an operator they
// administer, so echoing them back reveals nothing they could not already list.
export class ManagerAssignmentRejectedError extends DomainError {
  constructor(reason: string, userIds: string[]) {
    super(`Manager assignment rejected — ${reason}: ${userIds.join(', ')}`)
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

// The impact dry run found at least one hard stop. Carries the full blocker list rather
// than only the first, so one round trip tells the caller everything they must clear —
// and the same list the /impact preview showed them.
export class LifecycleActionBlockedError extends DomainError {
  constructor(
    action: string,
    resource: string,
    id: string,
    readonly blockers: ReadonlyArray<{ code: string; message: string; remedy: string }>,
  ) {
    super(
      `Cannot ${action} ${resource} ${id}: ${blockers.map((blocker) => blocker.message).join('; ')}`,
    )
  }
}

// Fail-closed bootstrap: purge needs a second holder of platform:tenant.purge to approve
// it, and a fresh install created by bootstrap:admin has exactly one. Auto-bypassing the
// two-person rule while only one holder exists would remove the control precisely in the
// situation a compromised sole account would exploit, so the purge is refused instead.
export class PurgeApproverUnavailableError extends DomainError {
  constructor() {
    super(
      'Purge needs a second platform administrator to approve it, and no other account holds that permission. Grant platform admin to a second person first.',
    )
  }
}

export class ApprovalNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Approval ${id} not found`)
  }
}

// The whole point of the control: the person who asked cannot be the second pair of eyes.
export class SelfApprovalError extends DomainError {
  constructor() {
    super(
      'You requested this purge and cannot approve it. A different platform administrator must.',
    )
  }
}

export class ApprovalExpiredError extends DomainError {
  constructor(id: string) {
    super(`Approval ${id} has expired and cannot be redeemed. Request the purge again.`)
  }
}

export class ApprovalNotPendingError extends DomainError {
  constructor(id: string, status: string) {
    super(`Approval ${id} is already ${status.toLowerCase()} and cannot be decided again`)
  }
}

export class ApprovalAlreadyPendingError extends DomainError {
  constructor(id: string) {
    super(`This purge is already awaiting approval (${id}). Have it approved or rejected first.`)
  }
}
