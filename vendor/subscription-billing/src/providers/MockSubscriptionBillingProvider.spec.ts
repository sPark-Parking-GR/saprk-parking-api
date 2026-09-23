import { MockSubscriptionBillingProvider } from './MockSubscriptionBillingProvider'
import type { CreateCheckoutSessionParams } from '../ISubscriptionBillingProvider'

const baseUrl = 'http://localhost:3010'

function sessionParams(
  overrides: Partial<CreateCheckoutSessionParams> = {},
): CreateCheckoutSessionParams {
  return {
    providerCustomerId: 'cus_mock_1',
    subscriber: { type: 'driver', id: 'user-1' },
    planId: 'plan-1',
    planCode: 'DRIVER_PLUS',
    priceCents: 499,
    currency: 'EUR',
    interval: 'MONTHLY',
    successUrl: 'spark://subscriptions/success',
    cancelUrl: 'spark://subscriptions/cancel',
    ...overrides,
  }
}

describe('MockSubscriptionBillingProvider', () => {
  let provider: MockSubscriptionBillingProvider

  beforeEach(() => {
    provider = new MockSubscriptionBillingProvider({ mockCheckoutBaseUrl: baseUrl })
  })

  describe('getOrCreateCustomer', () => {
    it('mints a customer id for a new subscriber', async () => {
      const result = await provider.getOrCreateCustomer({
        subscriber: { type: 'driver', id: 'user-1' },
        email: 'rider@example.com',
      })

      expect(result.providerCustomerId).toMatch(/^cus_mock_/)
    })

    it('returns the same customer for a repeated subscriber', async () => {
      const first = await provider.getOrCreateCustomer({
        subscriber: { type: 'driver', id: 'user-1' },
        email: 'rider@example.com',
      })
      const second = await provider.getOrCreateCustomer({
        subscriber: { type: 'driver', id: 'user-1' },
        email: 'rider@example.com',
      })

      expect(second.providerCustomerId).toBe(first.providerCustomerId)
    })

    it('keeps driver and operator subscribers with the same id apart', async () => {
      const driver = await provider.getOrCreateCustomer({
        subscriber: { type: 'driver', id: 'shared-id' },
        email: 'rider@example.com',
      })
      const operator = await provider.getOrCreateCustomer({
        subscriber: { type: 'operator', id: 'shared-id' },
        email: 'operator@example.com',
      })

      expect(operator.providerCustomerId).not.toBe(driver.providerCustomerId)
    })
  })

  describe('createCheckoutSession', () => {
    it('returns a session id and a url on the configured mock checkout base', async () => {
      const session = await provider.createCheckoutSession(sessionParams())

      expect(session.checkoutSessionId).toMatch(/^cs_mock_/)
      expect(session.checkoutUrl).toBe(
        `${baseUrl}/driver-subscriptions/mock-checkout/${session.checkoutSessionId}`,
      )
    })

    // The stand-in page is a route on the sPark API, and the two subscriber types are served
    // by structurally separate controllers — a URL naming the wrong one resolves nowhere.
    it('points an operator session at the operator checkout surface', async () => {
      const session = await provider.createCheckoutSession(
        sessionParams({ subscriber: { type: 'operator', id: 'op-1' } }),
      )

      expect(session.checkoutUrl).toBe(
        `${baseUrl}/operator-subscriptions/mock-checkout/${session.checkoutSessionId}`,
      )
    })

    it('stores what the checkout page needs to render the session, open', async () => {
      const session = await provider.createCheckoutSession(sessionParams())

      expect(provider.getCheckoutSession(session.checkoutSessionId)).toEqual({
        planCode: 'DRIVER_PLUS',
        priceCents: 499,
        currency: 'EUR',
        interval: 'MONTHLY',
        successUrl: 'spark://subscriptions/success',
        cancelUrl: 'spark://subscriptions/cancel',
        status: 'open',
      })
    })

    it('issues a distinct session per call', async () => {
      const first = await provider.createCheckoutSession(sessionParams())
      const second = await provider.createCheckoutSession(sessionParams())

      expect(second.checkoutSessionId).not.toBe(first.checkoutSessionId)
    })

    it('has no session to report for an unknown id', () => {
      expect(provider.getCheckoutSession('cs_mock_nope')).toBeUndefined()
    })
  })

  describe('completeCheckoutSession', () => {
    it('returns a fully populated checkout.completed event', async () => {
      const session = await provider.createCheckoutSession(sessionParams())

      const event = provider.completeCheckoutSession(session.checkoutSessionId)

      expect(event).toMatchObject({
        type: 'checkout.completed',
        providerCustomerId: 'cus_mock_1',
        status: 'active',
        subscriber: { type: 'driver', id: 'user-1' },
        planId: 'plan-1',
      })
      expect(event.id).toMatch(/^evt_mock_/)
      expect(event.providerSubscriptionId).toMatch(/^sub_mock_/)
      expect(event.currentPeriodEnd).toBeInstanceOf(Date)
      expect(event.raw).toBeDefined()
    })

    // The ordering key the consumer drops out-of-order deliveries with. A mock that omitted
    // it would let the whole local round trip pass while the defence was inert.
    it('stamps the event with the moment the checkout completed', async () => {
      const session = await provider.createCheckoutSession(sessionParams())
      const before = Date.now()

      const { eventCreatedAt } = provider.completeCheckoutSession(session.checkoutSessionId)

      expect(eventCreatedAt).toBeInstanceOf(Date)
      expect(eventCreatedAt.getTime()).toBeGreaterThanOrEqual(before)
    })

    it('dates the period one month out for a monthly plan', async () => {
      const session = await provider.createCheckoutSession(sessionParams())

      const { currentPeriodEnd } = provider.completeCheckoutSession(session.checkoutSessionId)

      const expected = new Date()
      expected.setUTCMonth(expected.getUTCMonth() + 1)
      expect(currentPeriodEnd!.getUTCMonth()).toBe(expected.getUTCMonth())
      expect(currentPeriodEnd!.getUTCFullYear()).toBe(expected.getUTCFullYear())
    })

    it('dates the period one year out for a yearly plan', async () => {
      const session = await provider.createCheckoutSession(sessionParams({ interval: 'YEARLY' }))

      const { currentPeriodEnd } = provider.completeCheckoutSession(session.checkoutSessionId)

      expect(currentPeriodEnd!.getUTCFullYear()).toBe(new Date().getUTCFullYear() + 1)
    })

    it('marks the stored session completed', async () => {
      const session = await provider.createCheckoutSession(sessionParams())

      provider.completeCheckoutSession(session.checkoutSessionId)

      expect(provider.getCheckoutSession(session.checkoutSessionId)?.status).toBe('completed')
    })

    it('refuses a second completion of the same session', async () => {
      const session = await provider.createCheckoutSession(sessionParams())
      provider.completeCheckoutSession(session.checkoutSessionId)

      expect(() => provider.completeCheckoutSession(session.checkoutSessionId)).toThrow(
        /already completed/,
      )
    })

    it('refuses to complete a cancelled session', async () => {
      const session = await provider.createCheckoutSession(sessionParams())
      provider.cancelCheckoutSession(session.checkoutSessionId)

      expect(() => provider.completeCheckoutSession(session.checkoutSessionId)).toThrow(
        /already cancelled/,
      )
    })

    it('refuses an unknown session', () => {
      expect(() => provider.completeCheckoutSession('cs_mock_nope')).toThrow(
        /unknown checkout session/,
      )
    })
  })

  describe('cancelCheckoutSession', () => {
    it('marks the stored session cancelled', async () => {
      const session = await provider.createCheckoutSession(sessionParams())

      provider.cancelCheckoutSession(session.checkoutSessionId)

      expect(provider.getCheckoutSession(session.checkoutSessionId)?.status).toBe('cancelled')
    })

    it('refuses to cancel a session that was already paid for', async () => {
      const session = await provider.createCheckoutSession(sessionParams())
      provider.completeCheckoutSession(session.checkoutSessionId)

      expect(() => provider.cancelCheckoutSession(session.checkoutSessionId)).toThrow(
        /already completed/,
      )
    })

    it('refuses an unknown session', () => {
      expect(() => provider.cancelCheckoutSession('cs_mock_nope')).toThrow(
        /unknown checkout session/,
      )
    })
  })

  describe('cancelSubscription', () => {
    it('cancels a subscription minted by a completed checkout', async () => {
      const session = await provider.createCheckoutSession(sessionParams())
      const { providerSubscriptionId } = provider.completeCheckoutSession(session.checkoutSessionId)

      await expect(provider.cancelSubscription(providerSubscriptionId!)).resolves.toBeUndefined()
    })

    it('throws for a subscription it never issued', async () => {
      await expect(provider.cancelSubscription('sub_mock_nope')).rejects.toThrow(
        /unknown subscription/,
      )
    })
  })

  describe('verifyWebhook', () => {
    const secret = 'whsec_mock'
    const payload = JSON.stringify({
      id: 'evt_1',
      type: 'subscription.updated',
      providerSubscriptionId: 'sub_mock_x',
      providerCustomerId: 'cus_mock_x',
      status: 'past_due',
      currentPeriodEnd: '2026-09-01T00:00:00.000Z',
    })
    let signed: MockSubscriptionBillingProvider

    beforeEach(() => {
      signed = new MockSubscriptionBillingProvider({
        mockCheckoutBaseUrl: baseUrl,
        webhookSecret: secret,
      })
    })

    it('parses a correctly signed payload into a normalized event', () => {
      const event = signed.verifyWebhook(
        payload,
        MockSubscriptionBillingProvider.sign(payload, secret),
      )

      expect(event).toMatchObject({
        id: 'evt_1',
        type: 'subscription.updated',
        providerSubscriptionId: 'sub_mock_x',
        providerCustomerId: 'cus_mock_x',
        status: 'past_due',
      })
      expect(event.currentPeriodEnd).toEqual(new Date('2026-09-01T00:00:00.000Z'))
    })

    // Honoured from the payload so an out-of-order delivery can be rehearsed against the real
    // handler — which is the only way to exercise the ordering guard locally.
    it('takes the event timestamp from the payload when one is named', () => {
      const body = JSON.stringify({
        type: 'subscription.updated',
        eventCreatedAt: '2026-08-27T11:00:00.000Z',
      })

      const event = signed.verifyWebhook(body, MockSubscriptionBillingProvider.sign(body, secret))

      expect(event.eventCreatedAt).toEqual(new Date('2026-08-27T11:00:00.000Z'))
    })

    // What a live provider's clock would read for an event it is minting on the spot.
    it('falls back to now when the payload names no timestamp', () => {
      const body = JSON.stringify({ type: 'subscription.updated' })
      const before = Date.now()

      const event = signed.verifyWebhook(body, MockSubscriptionBillingProvider.sign(body, secret))

      expect(event.eventCreatedAt.getTime()).toBeGreaterThanOrEqual(before)
    })

    it('leaves an omitted status undefined rather than assuming the subscription is live', () => {
      const body = JSON.stringify({ type: 'subscription.deleted' })

      const event = signed.verifyWebhook(body, MockSubscriptionBillingProvider.sign(body, secret))

      expect(event.status).toBeUndefined()
    })

    it('rejects an event type this engine does not model', () => {
      const body = JSON.stringify({ type: 'invoice.paid' })

      expect(() =>
        signed.verifyWebhook(body, MockSubscriptionBillingProvider.sign(body, secret)),
      ).toThrow(/Unsupported subscription billing event/)
    })

    it('rejects a signature produced with a different secret', () => {
      const forged = MockSubscriptionBillingProvider.sign(payload, 'whsec_attacker')

      expect(() => signed.verifyWebhook(payload, forged)).toThrow(/signature mismatch/)
    })

    it('rejects a payload tampered with after signing', () => {
      const signature = MockSubscriptionBillingProvider.sign(payload, secret)
      const tampered = payload.replace('sub_mock_x', 'sub_mock_attacker')

      expect(() => signed.verifyWebhook(tampered, signature)).toThrow(/signature mismatch/)
    })

    it('rejects a missing signature', () => {
      expect(() => signed.verifyWebhook(payload, '')).toThrow(/signature mismatch/)
    })

    it('refuses to verify when no secret is configured', () => {
      expect(() =>
        provider.verifyWebhook(payload, MockSubscriptionBillingProvider.sign(payload, '')),
      ).toThrow(/not configured/)
    })
  })
})
