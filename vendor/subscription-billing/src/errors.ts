/**
 * A webhook whose signature checked out but whose event type this engine does not model.
 * Distinct from a verification failure because the two deserve opposite answers: a forged
 * payload is rejected, an unrelated event is acknowledged and ignored.
 */
export class UnsupportedSubscriptionBillingEventError extends Error {
  constructor(readonly eventType: string) {
    super(`Unsupported subscription billing event: ${eventType}`)
    this.name = 'UnsupportedSubscriptionBillingEventError'
  }
}
