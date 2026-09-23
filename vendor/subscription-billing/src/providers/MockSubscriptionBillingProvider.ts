import { createHmac, randomUUID, timingSafeEqual } from 'crypto'
import type { BillingInterval } from '@spark/types'
import type {
  CheckoutSessionResult,
  CreateCheckoutSessionParams,
  CustomerResult,
  GetOrCreateCustomerParams,
  ISubscriptionBillingProvider,
  SubscriberRef,
  SubscriptionBillingEventType,
  SubscriptionBillingStatus,
  SubscriptionBillingWebhookEvent,
} from '../ISubscriptionBillingProvider'
import { UnsupportedSubscriptionBillingEventError } from '../errors'

export type MockCheckoutStatus = 'open' | 'completed' | 'cancelled'

interface MockCheckoutRecord {
  providerCustomerId: string
  subscriber: SubscriberRef
  planId: string
  planCode: string
  priceCents: number
  currency: string
  interval: BillingInterval
  successUrl: string
  cancelUrl: string
  status: MockCheckoutStatus
  providerSubscriptionId?: string
}

interface MockSubscriptionRecord {
  providerCustomerId: string
  subscriber: SubscriberRef
  planId: string
  status: SubscriptionBillingStatus
  currentPeriodEnd: Date
}

/** What the mock checkout page needs to render and act on a stored session. */
export interface MockCheckoutView {
  planCode: string
  priceCents: number
  currency: string
  interval: BillingInterval
  successUrl: string
  cancelUrl: string
  status: MockCheckoutStatus
}

export interface MockSubscriptionBillingConfig {
  mockCheckoutBaseUrl: string
  webhookSecret?: string
}

const EVENT_TYPES: readonly SubscriptionBillingEventType[] = [
  'checkout.completed',
  'subscription.updated',
  'subscription.deleted',
  'invoice.payment_failed',
]

function isEventType(value: unknown): value is SubscriptionBillingEventType {
  return EVENT_TYPES.includes(value as SubscriptionBillingEventType)
}

/**
 * Which API surface serves the stand-in checkout page for this subscriber. A real provider
 * hosts its own page and needs no such thing; the mock's page is a route on the sPark API,
 * and the driver and operator halves of subscription billing keep structurally separate
 * controllers — so the URL handed to the client has to name the one that can actually
 * resolve the session. Derived from the subscriber rather than configured, because the
 * subscriber is the only thing that decides it.
 */
function mockCheckoutSurface(subscriber: SubscriberRef): string {
  return subscriber.type === 'operator' ? 'operator-subscriptions' : 'driver-subscriptions'
}

function nextPeriodEnd(interval: BillingInterval, from: Date = new Date()): Date {
  const end = new Date(from.getTime())
  if (interval === 'YEARLY') end.setUTCFullYear(end.getUTCFullYear() + 1)
  else end.setUTCMonth(end.getUTCMonth() + 1)
  return end
}

export class MockSubscriptionBillingProvider implements ISubscriptionBillingProvider {
  readonly providerName = 'mock'

  private readonly customers = new Map<string, string>()
  private readonly sessions = new Map<string, MockCheckoutRecord>()
  private readonly subscriptions = new Map<string, MockSubscriptionRecord>()

  constructor(private readonly config: MockSubscriptionBillingConfig) {}

  async getOrCreateCustomer(params: GetOrCreateCustomerParams): Promise<CustomerResult> {
    const key = MockSubscriptionBillingProvider.subscriberKey(params.subscriber)
    const existing = this.customers.get(key)
    if (existing) return { providerCustomerId: existing }

    const providerCustomerId = `cus_mock_${randomUUID()}`
    this.customers.set(key, providerCustomerId)

    return { providerCustomerId }
  }

  async createCheckoutSession(params: CreateCheckoutSessionParams): Promise<CheckoutSessionResult> {
    const checkoutSessionId = `cs_mock_${randomUUID()}`
    this.sessions.set(checkoutSessionId, {
      providerCustomerId: params.providerCustomerId,
      subscriber: params.subscriber,
      planId: params.planId,
      planCode: params.planCode,
      priceCents: params.priceCents,
      currency: params.currency,
      interval: params.interval,
      successUrl: params.successUrl,
      cancelUrl: params.cancelUrl,
      status: 'open',
    })

    return {
      checkoutSessionId,
      checkoutUrl: `${this.config.mockCheckoutBaseUrl}/${mockCheckoutSurface(params.subscriber)}/mock-checkout/${checkoutSessionId}`,
    }
  }

  async cancelSubscription(providerSubscriptionId: string): Promise<void> {
    const record = this.subscriptions.get(providerSubscriptionId)
    if (!record) {
      throw new Error(
        `MockSubscriptionBillingProvider: unknown subscription ${providerSubscriptionId}`,
      )
    }

    record.status = 'canceled'
  }

  /** Mock-only: lets the stand-in checkout page render the session it was opened for. */
  getCheckoutSession(checkoutSessionId: string): MockCheckoutView | undefined {
    const record = this.sessions.get(checkoutSessionId)
    if (!record) return undefined

    return {
      planCode: record.planCode,
      priceCents: record.priceCents,
      currency: record.currency,
      interval: record.interval,
      successUrl: record.successUrl,
      cancelUrl: record.cancelUrl,
      status: record.status,
    }
  }

  /**
   * Mock-only: the in-process stand-in for a completed hosted checkout. The event it
   * returns is fed to the same handler a real Stripe webhook reaches, so the mock path
   * exercises the production code path rather than a shortcut around it.
   */
  completeCheckoutSession(checkoutSessionId: string): SubscriptionBillingWebhookEvent {
    const record = this.sessions.get(checkoutSessionId)
    if (!record) {
      throw new Error(
        `MockSubscriptionBillingProvider: unknown checkout session ${checkoutSessionId}`,
      )
    }
    // A hosted checkout page cannot be paid twice, and a second completion here would mint
    // a second subscription for one purchase.
    if (record.status !== 'open') {
      throw new Error(
        `MockSubscriptionBillingProvider: checkout session ${checkoutSessionId} is already ${record.status}`,
      )
    }

    const providerSubscriptionId = `sub_mock_${randomUUID()}`
    const currentPeriodEnd = nextPeriodEnd(record.interval)
    record.status = 'completed'
    record.providerSubscriptionId = providerSubscriptionId
    this.subscriptions.set(providerSubscriptionId, {
      providerCustomerId: record.providerCustomerId,
      subscriber: record.subscriber,
      planId: record.planId,
      status: 'active',
      currentPeriodEnd,
    })

    return {
      id: `evt_mock_${randomUUID()}`,
      type: 'checkout.completed',
      eventCreatedAt: new Date(),
      providerCustomerId: record.providerCustomerId,
      providerSubscriptionId,
      status: 'active',
      currentPeriodEnd,
      subscriber: record.subscriber,
      planId: record.planId,
      raw: { checkoutSessionId, ...record },
    }
  }

  /** Mock-only: the stand-in checkout page's abandon action. */
  cancelCheckoutSession(checkoutSessionId: string): void {
    const record = this.sessions.get(checkoutSessionId)
    if (!record) {
      throw new Error(
        `MockSubscriptionBillingProvider: unknown checkout session ${checkoutSessionId}`,
      )
    }
    if (record.status === 'completed') {
      throw new Error(
        `MockSubscriptionBillingProvider: checkout session ${checkoutSessionId} is already completed`,
      )
    }

    record.status = 'cancelled'
  }

  static sign(payload: Buffer | string, secret: string): string {
    return createHmac('sha256', secret).update(payload).digest('hex')
  }

  private static subscriberKey(subscriber: SubscriberRef): string {
    return `${subscriber.type}:${subscriber.id}`
  }

  verifyWebhook(payload: Buffer | string, signature: string): SubscriptionBillingWebhookEvent {
    // Fail closed. `mock` is the default provider and its webhook route is public, so an
    // unconfigured secret has to make the endpoint unusable rather than unauthenticated.
    if (!this.config.webhookSecret) {
      throw new Error(
        'MockSubscriptionBillingProvider.verifyWebhook: webhookSecret is not configured',
      )
    }

    const expected = Buffer.from(
      MockSubscriptionBillingProvider.sign(payload, this.config.webhookSecret),
    )
    const received = Buffer.from(signature)
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      throw new Error('MockSubscriptionBillingProvider.verifyWebhook: signature mismatch')
    }

    const text = typeof payload === 'string' ? payload : payload.toString('utf8')
    const parsed = JSON.parse(text) as {
      id?: string
      type?: string
      eventCreatedAt?: string
      providerCustomerId?: string
      providerSubscriptionId?: string
      status?: SubscriptionBillingStatus
      currentPeriodEnd?: string
      subscriber?: SubscriberRef
      planId?: string
    }

    if (!isEventType(parsed.type)) {
      throw new UnsupportedSubscriptionBillingEventError(String(parsed.type))
    }

    return {
      id: parsed.id ?? `evt_mock_${randomUUID()}`,
      type: parsed.type,
      // Honoured when the payload names one so an out-of-order delivery can be rehearsed
      // against the real handler; now otherwise, which is what a live provider's clock would
      // read for an event it is minting on the spot.
      eventCreatedAt: parsed.eventCreatedAt ? new Date(parsed.eventCreatedAt) : new Date(),
      providerCustomerId: parsed.providerCustomerId,
      providerSubscriptionId: parsed.providerSubscriptionId,
      // Deliberately not defaulted: a cancellation payload that omitted its status would
      // otherwise be read as a renewal.
      status: parsed.status,
      currentPeriodEnd: parsed.currentPeriodEnd ? new Date(parsed.currentPeriodEnd) : undefined,
      subscriber: parsed.subscriber,
      planId: parsed.planId,
      raw: parsed,
    }
  }
}
