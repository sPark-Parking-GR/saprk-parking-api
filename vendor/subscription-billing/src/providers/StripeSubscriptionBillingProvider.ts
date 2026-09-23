import Stripe from 'stripe'
import type { BillingInterval } from '@spark/types'
import type {
  CheckoutSessionResult,
  CreateCheckoutSessionParams,
  CustomerResult,
  GetOrCreateCustomerParams,
  ISubscriptionBillingProvider,
  SubscriberRef,
  SubscriptionBillingStatus,
  SubscriptionBillingWebhookEvent,
} from '../ISubscriptionBillingProvider'
import { UnsupportedSubscriptionBillingEventError } from '../errors'

export interface StripeSubscriptionBillingConfig {
  secretKey: string
  webhookSecret: string
}

// Pinned so an SDK upgrade cannot silently change request or response shapes on a live
// billing flow. Bump deliberately, with the Stripe upgrade notes.
const STRIPE_API_VERSION = '2025-02-24.acacia'

const RECURRING_INTERVAL: Record<BillingInterval, Stripe.PriceCreateParams.Recurring.Interval> = {
  MONTHLY: 'month',
  YEARLY: 'year',
}

// Statuses we do not model map to `undefined` rather than a guess: `incomplete` is a
// subscription that has never been paid and `paused` collects no money, so inventing
// either "active" or "canceled" would grant entitlements nobody paid for or revoke ones
// they did. Leaving the status out tells the caller to change nothing.
const SUBSCRIPTION_STATUS: Partial<Record<Stripe.Subscription.Status, SubscriptionBillingStatus>> =
  {
    active: 'active',
    trialing: 'trialing',
    past_due: 'past_due',
    // Stripe has stopped retrying; the entitlement is lapsed but the subscription is not
    // gone, which is exactly what past_due means downstream.
    unpaid: 'past_due',
    canceled: 'canceled',
    incomplete_expired: 'canceled',
  }

// The Stripe search query language quotes values in single quotes, so an id carrying one
// could close the literal and rewrite the filter. Local ids are cuid/uuid shaped; anything
// else is rejected rather than escaped.
const SAFE_SUBSCRIBER_ID = /^[A-Za-z0-9_-]{1,255}$/

function mapSubscriptionStatus(status: string): SubscriptionBillingStatus | undefined {
  return SUBSCRIPTION_STATUS[status as Stripe.Subscription.Status]
}

function referencedId(ref: string | { id: string } | null | undefined): string | undefined {
  if (!ref) return undefined
  return typeof ref === 'string' ? ref : ref.id
}

function periodEnd(seconds: number | null | undefined): Date | undefined {
  return typeof seconds === 'number' ? new Date(seconds * 1000) : undefined
}

function readSubscriber(metadata: Stripe.Metadata | null | undefined): SubscriberRef | undefined {
  const type = metadata?.subscriberType
  const id = metadata?.subscriberId
  if ((type !== 'driver' && type !== 'operator') || !id) return undefined
  return { type, id }
}

export class StripeSubscriptionBillingProvider implements ISubscriptionBillingProvider {
  readonly providerName = 'stripe'

  private readonly stripe: Stripe

  constructor(private readonly config: StripeSubscriptionBillingConfig) {
    this.stripe = new Stripe(config.secretKey, { apiVersion: STRIPE_API_VERSION })
  }

  async getOrCreateCustomer(params: GetOrCreateCustomerParams): Promise<CustomerResult> {
    const { subscriber, email } = params
    if (!SAFE_SUBSCRIBER_ID.test(subscriber.id)) {
      throw new Error('StripeSubscriptionBillingProvider: unsupported subscriber id')
    }

    const found = await this.stripe.customers.search({
      query: `metadata['subscriberType']:'${subscriber.type}' AND metadata['subscriberId']:'${subscriber.id}'`,
      limit: 1,
    })
    const existing = found.data[0]
    if (existing) return { providerCustomerId: existing.id }

    const customer = await this.stripe.customers.create(
      {
        email,
        metadata: { subscriberType: subscriber.type, subscriberId: subscriber.id },
      },
      // Search is eventually consistent, so two calls seconds apart can both miss. The
      // deterministic key closes that window: Stripe replays the first customer instead of
      // creating a second one for the same subscriber.
      { idempotencyKey: `customer_${subscriber.type}_${subscriber.id}` },
    )

    return { providerCustomerId: customer.id }
  }

  async createCheckoutSession(params: CreateCheckoutSessionParams): Promise<CheckoutSessionResult> {
    // Prices are built inline from our own catalog rather than referencing dashboard-managed
    // Price objects, so the plan row in our database stays the single source of truth.
    const metadata = {
      subscriberType: params.subscriber.type,
      subscriberId: params.subscriber.id,
      planId: params.planId,
    }

    const options: Stripe.RequestOptions = {}
    // Idempotency belongs in the request options, never the body: Stripe stores the first
    // response per key and replays it verbatim, so a retried upgrade tap reaches the same
    // hosted checkout instead of opening a second one.
    if (params.idempotencyKey) options.idempotencyKey = params.idempotencyKey

    const session = await this.stripe.checkout.sessions.create(
      {
        mode: 'subscription',
        customer: params.providerCustomerId,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: params.currency.toLowerCase(),
              unit_amount: params.priceCents,
              recurring: { interval: RECURRING_INTERVAL[params.interval] },
              product_data: { name: params.planCode },
            },
          },
        ],
        success_url: params.successUrl,
        cancel_url: params.cancelUrl,
        metadata,
        // Copied onto the Subscription as well, because renewal and cancellation events
        // carry the subscription's own metadata and never the session's.
        subscription_data: { metadata },
      },
      options,
    )

    if (!session.url) {
      throw new Error('StripeSubscriptionBillingProvider: checkout session has no url')
    }

    return { checkoutSessionId: session.id, checkoutUrl: session.url }
  }

  async cancelSubscription(providerSubscriptionId: string): Promise<void> {
    await this.stripe.subscriptions.cancel(providerSubscriptionId)
  }

  verifyWebhook(payload: Buffer | string, signature: string): SubscriptionBillingWebhookEvent {
    // An empty secret still produces a verifiable HMAC, so an unconfigured endpoint must
    // refuse outright rather than accept anything signed with ''.
    if (!this.config.webhookSecret) {
      throw new Error(
        'StripeSubscriptionBillingProvider.verifyWebhook: webhookSecret is not configured',
      )
    }

    const event = this.stripe.webhooks.constructEvent(payload, signature, this.config.webhookSecret)

    return this.normalize(event)
  }

  private normalize(event: Stripe.Event): SubscriptionBillingWebhookEvent {
    // `event.created` is Unix SECONDS, and it is the provider's own clock — the one thing
    // that survives a redelivery unchanged, so it is what orders a retry against the events
    // that overtook it.
    const base = { id: event.id, raw: event, eventCreatedAt: new Date(event.created * 1000) }

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session
        const subscription = session.subscription
        return {
          ...base,
          type: 'checkout.completed',
          providerCustomerId: referencedId(session.customer),
          providerSubscriptionId: referencedId(subscription),
          // A completed checkout has been paid for; the period end is only known here when
          // the subscription arrives expanded, and the subscription event that follows
          // carries it otherwise.
          status: 'active',
          currentPeriodEnd:
            typeof subscription === 'object' && subscription !== null
              ? periodEnd(subscription.current_period_end)
              : undefined,
          subscriber: readSubscriber(session.metadata),
          planId: session.metadata?.planId,
        }
      }
      // `created` normalizes to the same shape on purpose: it is the first event carrying a
      // period end after checkout, and syncing status/period is idempotent.
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription
        const deleted = event.type === 'customer.subscription.deleted'
        return {
          ...base,
          type: deleted ? 'subscription.deleted' : 'subscription.updated',
          providerCustomerId: referencedId(subscription.customer),
          providerSubscriptionId: subscription.id,
          status: deleted ? 'canceled' : mapSubscriptionStatus(subscription.status),
          currentPeriodEnd: periodEnd(subscription.current_period_end),
          subscriber: readSubscriber(subscription.metadata),
          planId: subscription.metadata?.planId,
        }
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice
        return {
          ...base,
          type: 'invoice.payment_failed',
          providerCustomerId: referencedId(invoice.customer),
          providerSubscriptionId: referencedId(invoice.subscription),
          status: 'past_due',
        }
      }
      default:
        // Signature-verified but outside this engine's vocabulary. Thrown as its own type so
        // the caller can acknowledge it instead of answering Stripe with the 4xx that a
        // genuine verification failure deserves.
        throw new UnsupportedSubscriptionBillingEventError(event.type)
    }
  }
}
