import Stripe from 'stripe'
import { StripeSubscriptionBillingProvider } from './StripeSubscriptionBillingProvider'
import { UnsupportedSubscriptionBillingEventError } from '../errors'
import type { SubscriptionBillingStatus } from '../ISubscriptionBillingProvider'

const mockStripe = {
  customers: { search: jest.fn(), create: jest.fn() },
  checkout: { sessions: { create: jest.fn() } },
  subscriptions: { cancel: jest.fn() },
  webhooks: { constructEvent: jest.fn() },
}

jest.mock('stripe', () => ({
  __esModule: true,
  default: jest.fn(() => mockStripe),
}))

const StripeCtor = Stripe as unknown as jest.Mock

const PERIOD_END = 1_767_225_600
// Stripe stamps `created` in Unix SECONDS, which is the whole reason this needs a test.
const CREATED = 1_756_296_000

function event(type: string, object: Record<string, unknown>): Stripe.Event {
  return { id: 'evt_1', type, created: CREATED, data: { object } } as unknown as Stripe.Event
}

function sessionParams() {
  return {
    providerCustomerId: 'cus_1',
    subscriber: { type: 'driver' as const, id: 'user-1' },
    planId: 'plan-1',
    planCode: 'DRIVER_PLUS',
    priceCents: 499,
    currency: 'EUR',
    interval: 'MONTHLY' as const,
    successUrl: 'https://app.example.com/ok',
    cancelUrl: 'https://app.example.com/cancel',
  }
}

describe('StripeSubscriptionBillingProvider', () => {
  let provider: StripeSubscriptionBillingProvider

  beforeEach(() => {
    jest.clearAllMocks()
    provider = new StripeSubscriptionBillingProvider({
      secretKey: 'sk_test',
      webhookSecret: 'whsec_test',
    })
  })

  it('pins the API version instead of drifting with the SDK default', () => {
    expect(StripeCtor).toHaveBeenCalledWith('sk_test', { apiVersion: '2025-02-24.acacia' })
  })

  describe('getOrCreateCustomer', () => {
    it('reuses the customer already tagged with this subscriber', async () => {
      mockStripe.customers.search.mockResolvedValue({ data: [{ id: 'cus_existing' }] })

      const result = await provider.getOrCreateCustomer({
        subscriber: { type: 'driver', id: 'user-1' },
        email: 'rider@example.com',
      })

      expect(mockStripe.customers.search).toHaveBeenCalledWith({
        query: "metadata['subscriberType']:'driver' AND metadata['subscriberId']:'user-1'",
        limit: 1,
      })
      expect(mockStripe.customers.create).not.toHaveBeenCalled()
      expect(result.providerCustomerId).toBe('cus_existing')
    })

    it('creates a metadata-tagged customer under a deterministic idempotency key', async () => {
      mockStripe.customers.search.mockResolvedValue({ data: [] })
      mockStripe.customers.create.mockResolvedValue({ id: 'cus_new' })

      const result = await provider.getOrCreateCustomer({
        subscriber: { type: 'driver', id: 'user-1' },
        email: 'rider@example.com',
      })

      const [body, options] = mockStripe.customers.create.mock.calls[0]
      expect(body).toEqual({
        email: 'rider@example.com',
        metadata: { subscriberType: 'driver', subscriberId: 'user-1' },
      })
      expect(options).toEqual({ idempotencyKey: 'customer_driver_user-1' })
      expect(result.providerCustomerId).toBe('cus_new')
    })

    it('refuses an id that could rewrite the search query', async () => {
      await expect(
        provider.getOrCreateCustomer({
          subscriber: { type: 'driver', id: "x' OR metadata['subscriberId']:'y" },
          email: 'rider@example.com',
        }),
      ).rejects.toThrow(/unsupported subscriber id/)
      expect(mockStripe.customers.search).not.toHaveBeenCalled()
    })
  })

  describe('createCheckoutSession', () => {
    beforeEach(() => {
      mockStripe.checkout.sessions.create.mockResolvedValue({
        id: 'cs_1',
        url: 'https://checkout.stripe.com/c/pay/cs_1',
      })
    })

    it('creates a subscription-mode session priced from our own catalog', async () => {
      const result = await provider.createCheckoutSession(sessionParams())

      const [body] = mockStripe.checkout.sessions.create.mock.calls[0]
      expect(body).toMatchObject({
        mode: 'subscription',
        customer: 'cus_1',
        success_url: 'https://app.example.com/ok',
        cancel_url: 'https://app.example.com/cancel',
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: 'eur',
              unit_amount: 499,
              recurring: { interval: 'month' },
              product_data: { name: 'DRIVER_PLUS' },
            },
          },
        ],
      })
      expect(body.line_items[0]).not.toHaveProperty('price')
      expect(result).toEqual({
        checkoutSessionId: 'cs_1',
        checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_1',
      })
    })

    it('tags both the session and the subscription so later events identify the buyer', async () => {
      await provider.createCheckoutSession(sessionParams())

      const [body] = mockStripe.checkout.sessions.create.mock.calls[0]
      const metadata = { subscriberType: 'driver', subscriberId: 'user-1', planId: 'plan-1' }
      expect(body.metadata).toEqual(metadata)
      expect(body.subscription_data).toEqual({ metadata })
    })

    it('maps a yearly plan to a yearly recurring price', async () => {
      await provider.createCheckoutSession({ ...sessionParams(), interval: 'YEARLY' })

      const [body] = mockStripe.checkout.sessions.create.mock.calls[0]
      expect(body.line_items[0].price_data.recurring).toEqual({ interval: 'year' })
    })

    it('sends the idempotency key in the request options, never in the body', async () => {
      await provider.createCheckoutSession({
        ...sessionParams(),
        idempotencyKey: 'cs_user-1_plan-1',
      })

      const [body, options] = mockStripe.checkout.sessions.create.mock.calls[0]
      expect(options).toEqual({ idempotencyKey: 'cs_user-1_plan-1' })
      expect(body).not.toHaveProperty('idempotencyKey')
    })

    it('omits the idempotency key when the caller does not supply one', async () => {
      await provider.createCheckoutSession(sessionParams())

      const [, options] = mockStripe.checkout.sessions.create.mock.calls[0]
      expect(options).toEqual({})
    })

    it('fails loudly when Stripe returns a session with no hosted url', async () => {
      mockStripe.checkout.sessions.create.mockResolvedValue({ id: 'cs_1', url: null })

      await expect(provider.createCheckoutSession(sessionParams())).rejects.toThrow(/no url/)
    })
  })

  describe('cancelSubscription', () => {
    it('cancels the subscription at Stripe', async () => {
      mockStripe.subscriptions.cancel.mockResolvedValue({ id: 'sub_1', status: 'canceled' })

      await provider.cancelSubscription('sub_1')

      expect(mockStripe.subscriptions.cancel).toHaveBeenCalledWith('sub_1')
    })
  })

  describe('verifyWebhook', () => {
    it('refuses to verify when no webhook secret is configured', () => {
      const unconfigured = new StripeSubscriptionBillingProvider({
        secretKey: 'sk_test',
        webhookSecret: '',
      })

      expect(() => unconfigured.verifyWebhook('{}', 'sig')).toThrow(/not configured/)
      expect(mockStripe.webhooks.constructEvent).not.toHaveBeenCalled()
    })

    it('verifies against the configured secret and propagates a rejection', () => {
      mockStripe.webhooks.constructEvent.mockImplementation(() => {
        throw new Error('No signatures found matching the expected signature for payload')
      })

      expect(() => provider.verifyWebhook('{}', 'bad')).toThrow(/No signatures found/)
      expect(mockStripe.webhooks.constructEvent).toHaveBeenCalledWith('{}', 'bad', 'whsec_test')
    })

    it('normalizes a completed checkout with the subscriber pulled from metadata', () => {
      mockStripe.webhooks.constructEvent.mockReturnValue(
        event('checkout.session.completed', {
          id: 'cs_1',
          object: 'checkout.session',
          customer: 'cus_1',
          subscription: 'sub_1',
          metadata: { subscriberType: 'driver', subscriberId: 'user-1', planId: 'plan-1' },
        }),
      )

      expect(provider.verifyWebhook('{}', 'sig')).toMatchObject({
        id: 'evt_1',
        type: 'checkout.completed',
        providerCustomerId: 'cus_1',
        providerSubscriptionId: 'sub_1',
        status: 'active',
        subscriber: { type: 'driver', id: 'user-1' },
        planId: 'plan-1',
      })
    })

    it('reads the period end off a checkout whose subscription arrives expanded', () => {
      mockStripe.webhooks.constructEvent.mockReturnValue(
        event('checkout.session.completed', {
          id: 'cs_1',
          object: 'checkout.session',
          customer: { id: 'cus_1' },
          subscription: { id: 'sub_1', current_period_end: PERIOD_END },
          metadata: { subscriberType: 'driver', subscriberId: 'user-1', planId: 'plan-1' },
        }),
      )

      const normalized = provider.verifyWebhook('{}', 'sig')

      expect(normalized.providerCustomerId).toBe('cus_1')
      expect(normalized.providerSubscriptionId).toBe('sub_1')
      expect(normalized.currentPeriodEnd).toEqual(new Date(PERIOD_END * 1000))
    })

    it('leaves the subscriber out when the metadata is not a subscriber we recognise', () => {
      mockStripe.webhooks.constructEvent.mockReturnValue(
        event('checkout.session.completed', {
          id: 'cs_1',
          object: 'checkout.session',
          customer: 'cus_1',
          subscription: 'sub_1',
          metadata: { subscriberType: 'martian', subscriberId: 'user-1' },
        }),
      )

      expect(provider.verifyWebhook('{}', 'sig').subscriber).toBeUndefined()
    })

    /**
     * The ordering key the consumer drops out-of-order deliveries with. Seconds read as
     * milliseconds would put every event in 1970, making the comparison meaningless and
     * silently disabling the defence it exists for.
     */
    it.each([
      ['checkout.session.completed', { id: 'cs_1', object: 'checkout.session' }],
      ['customer.subscription.updated', { id: 'sub_1', object: 'subscription', status: 'active' }],
      ['invoice.payment_failed', { id: 'in_1', object: 'invoice' }],
    ])('carries Stripe’s own event.created onto every %s it normalizes', (type, object) => {
      mockStripe.webhooks.constructEvent.mockReturnValue(event(type, object))

      expect(provider.verifyWebhook('{}', 'sig').eventCreatedAt).toEqual(new Date(CREATED * 1000))
    })

    it('normalizes a renewal, carrying the period end and provider ids', () => {
      mockStripe.webhooks.constructEvent.mockReturnValue(
        event('customer.subscription.updated', {
          id: 'sub_1',
          object: 'subscription',
          customer: 'cus_1',
          status: 'active',
          current_period_end: PERIOD_END,
          metadata: { subscriberType: 'driver', subscriberId: 'user-1', planId: 'plan-1' },
        }),
      )

      expect(provider.verifyWebhook('{}', 'sig')).toMatchObject({
        type: 'subscription.updated',
        providerCustomerId: 'cus_1',
        providerSubscriptionId: 'sub_1',
        status: 'active',
        currentPeriodEnd: new Date(PERIOD_END * 1000),
        subscriber: { type: 'driver', id: 'user-1' },
        planId: 'plan-1',
      })
    })

    it('normalizes the first subscription event after checkout the same way', () => {
      mockStripe.webhooks.constructEvent.mockReturnValue(
        event('customer.subscription.created', {
          id: 'sub_1',
          object: 'subscription',
          customer: 'cus_1',
          status: 'trialing',
          current_period_end: PERIOD_END,
        }),
      )

      expect(provider.verifyWebhook('{}', 'sig')).toMatchObject({
        type: 'subscription.updated',
        status: 'trialing',
      })
    })

    it('identifies a subscription event by provider ids even with no metadata', () => {
      mockStripe.webhooks.constructEvent.mockReturnValue(
        event('customer.subscription.updated', {
          id: 'sub_1',
          object: 'subscription',
          customer: 'cus_1',
          status: 'past_due',
          current_period_end: PERIOD_END,
        }),
      )

      const normalized = provider.verifyWebhook('{}', 'sig')

      expect(normalized.subscriber).toBeUndefined()
      expect(normalized.planId).toBeUndefined()
      expect(normalized.providerSubscriptionId).toBe('sub_1')
      expect(normalized.providerCustomerId).toBe('cus_1')
    })

    it.each<[string, SubscriptionBillingStatus]>([
      ['active', 'active'],
      ['trialing', 'trialing'],
      ['past_due', 'past_due'],
      ['unpaid', 'past_due'],
      ['canceled', 'canceled'],
      ['incomplete_expired', 'canceled'],
    ])('maps stripe subscription status %s to %s', (stripeStatus, expected) => {
      mockStripe.webhooks.constructEvent.mockReturnValue(
        event('customer.subscription.updated', {
          id: 'sub_1',
          object: 'subscription',
          customer: 'cus_1',
          status: stripeStatus,
        }),
      )

      expect(provider.verifyWebhook('{}', 'sig').status).toBe(expected)
    })

    it.each(['incomplete', 'paused', 'teleporting'])(
      'reports no status at all for %s rather than guessing one',
      (stripeStatus) => {
        mockStripe.webhooks.constructEvent.mockReturnValue(
          event('customer.subscription.updated', {
            id: 'sub_1',
            object: 'subscription',
            customer: 'cus_1',
            status: stripeStatus,
          }),
        )

        expect(provider.verifyWebhook('{}', 'sig').status).toBeUndefined()
      },
    )

    it('normalizes a deletion as canceled', () => {
      mockStripe.webhooks.constructEvent.mockReturnValue(
        event('customer.subscription.deleted', {
          id: 'sub_1',
          object: 'subscription',
          customer: 'cus_1',
          status: 'canceled',
        }),
      )

      expect(provider.verifyWebhook('{}', 'sig')).toMatchObject({
        type: 'subscription.deleted',
        providerSubscriptionId: 'sub_1',
        status: 'canceled',
      })
    })

    it('normalizes a failed invoice to past_due against the subscription it belongs to', () => {
      mockStripe.webhooks.constructEvent.mockReturnValue(
        event('invoice.payment_failed', {
          id: 'in_1',
          object: 'invoice',
          customer: 'cus_1',
          subscription: 'sub_1',
        }),
      )

      expect(provider.verifyWebhook('{}', 'sig')).toMatchObject({
        type: 'invoice.payment_failed',
        providerCustomerId: 'cus_1',
        providerSubscriptionId: 'sub_1',
        status: 'past_due',
      })
    })

    it('rejects a verified event this engine does not model, as its own error type', () => {
      mockStripe.webhooks.constructEvent.mockReturnValue(
        event('invoice.paid', { id: 'in_1', object: 'invoice' }),
      )

      expect(() => provider.verifyWebhook('{}', 'sig')).toThrow(
        UnsupportedSubscriptionBillingEventError,
      )
    })
  })
})
