import type { BillingInterval } from '@spark/types'

/**
 * Who the subscription belongs to. Generic on purpose: the same engine backs driver
 * (rider) subscriptions now and operator self-serve billing later, so nothing below may
 * assume one audience.
 */
export interface SubscriberRef {
  type: 'driver' | 'operator'
  id: string
}

export interface GetOrCreateCustomerParams {
  subscriber: SubscriberRef
  email: string
}

export interface CustomerResult {
  providerCustomerId: string
}

export interface CreateCheckoutSessionParams {
  providerCustomerId: string
  subscriber: SubscriberRef
  planId: string
  planCode: string
  priceCents: number
  currency: string
  interval: BillingInterval
  successUrl: string
  cancelUrl: string
  idempotencyKey?: string
}

export interface CheckoutSessionResult {
  checkoutSessionId: string
  checkoutUrl: string
}

export type SubscriptionBillingEventType =
  'checkout.completed' | 'subscription.updated' | 'subscription.deleted' | 'invoice.payment_failed'

/**
 * Provider-side status, deliberately not the `SubscriptionStatus` enum this codebase
 * stores: mapping a provider vocabulary onto our own belongs to the caller that owns the
 * write, and collapsing the two here would hide a provider adding a state we do not model.
 */
export type SubscriptionBillingStatus = 'active' | 'past_due' | 'canceled' | 'trialing'

/**
 * Every field but `id`, `type` and `raw` is optional because the provider populates
 * different subsets per event: a completed checkout carries the subscriber and plan it was
 * started for, while later renewal/cancellation/failure events may carry only provider
 * ids. `providerSubscriptionId`/`providerCustomerId` are therefore the only identifiers a
 * caller may rely on across the whole event set.
 */
export interface SubscriptionBillingWebhookEvent {
  id: string
  type: SubscriptionBillingEventType
  /**
   * When the PROVIDER minted the event, not when we received it. Required rather than
   * optional because it is the only thing that orders two deliveries against each other:
   * webhooks arrive out of order whenever one delivery fails and is retried behind a later
   * one, and without this a stale `active` event overwrites a newer cancellation or a newer
   * period end. A consumer that cannot order its events cannot be idempotent, only lucky.
   */
  eventCreatedAt: Date
  providerCustomerId?: string
  providerSubscriptionId?: string
  status?: SubscriptionBillingStatus
  currentPeriodEnd?: Date
  subscriber?: SubscriberRef
  planId?: string
  raw: unknown
}

export interface ISubscriptionBillingProvider {
  readonly providerName: string

  getOrCreateCustomer(params: GetOrCreateCustomerParams): Promise<CustomerResult>

  createCheckoutSession(params: CreateCheckoutSessionParams): Promise<CheckoutSessionResult>

  cancelSubscription(providerSubscriptionId: string): Promise<void>

  verifyWebhook(payload: Buffer | string, signature: string): SubscriptionBillingWebhookEvent
}
