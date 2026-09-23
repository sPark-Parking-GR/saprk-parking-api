import Stripe from 'stripe'
import type { PaymentIntentStatus } from '@spark/types'
import { StripeProvider } from './StripeProvider'

const mockStripe = {
  paymentIntents: { create: jest.fn(), capture: jest.fn(), retrieve: jest.fn() },
  refunds: { create: jest.fn() },
  webhooks: { constructEvent: jest.fn() },
}

jest.mock('stripe', () => ({
  __esModule: true,
  default: jest.fn(() => mockStripe),
}))

const StripeCtor = Stripe as unknown as jest.Mock

function intentResponse(overrides: Record<string, unknown> = {}): Stripe.PaymentIntent {
  return {
    id: 'pi_1',
    object: 'payment_intent',
    amount: 1500,
    currency: 'eur',
    client_secret: 'pi_1_secret_abc',
    status: 'requires_payment_method',
    ...overrides,
  } as unknown as Stripe.PaymentIntent
}

function refundResponse(overrides: Record<string, unknown> = {}): Stripe.Refund {
  return {
    id: 're_1',
    object: 'refund',
    amount: 1500,
    status: 'succeeded',
    payment_intent: 'pi_1',
    ...overrides,
  } as unknown as Stripe.Refund
}

function event(type: string, object: Record<string, unknown>): Stripe.Event {
  return { id: 'evt_1', type, data: { object } } as unknown as Stripe.Event
}

describe('StripeProvider', () => {
  let provider: StripeProvider

  beforeEach(() => {
    jest.clearAllMocks()
    provider = new StripeProvider({ secretKey: 'sk_test', webhookSecret: 'whsec_test' })
  })

  it('pins the API version instead of drifting with the SDK default', () => {
    expect(StripeCtor).toHaveBeenCalledWith('sk_test', { apiVersion: '2025-02-24.acacia' })
  })

  describe('createPaymentIntent', () => {
    beforeEach(() => {
      mockStripe.paymentIntents.create.mockResolvedValue(intentResponse())
    })

    it('creates a manual-capture intent and returns the client secret', async () => {
      const intent = await provider.createPaymentIntent({
        amountCents: 1500,
        currency: 'EUR',
        idempotencyKey: 'pi_booking-1',
        description: 'Parking booking',
        metadata: { bookingId: 'booking-1' },
      })

      const [body] = mockStripe.paymentIntents.create.mock.calls[0]
      expect(body).toMatchObject({
        amount: 1500,
        currency: 'eur',
        capture_method: 'manual',
        description: 'Parking booking',
        metadata: { bookingId: 'booking-1' },
      })
      expect(intent.clientSecret).toBe('pi_1_secret_abc')
      expect(intent.providerPaymentId).toBe('pi_1')
    })

    it('sends the idempotency key in the request options, never in the body', async () => {
      await provider.createPaymentIntent({
        amountCents: 1500,
        currency: 'EUR',
        idempotencyKey: 'pi_booking-1',
      })

      const [body, options] = mockStripe.paymentIntents.create.mock.calls[0]
      expect(options).toEqual({ idempotencyKey: 'pi_booking-1' })
      expect(body).not.toHaveProperty('idempotencyKey')
    })

    it('returns the client secret again when Stripe replays a stored response', async () => {
      const params = {
        amountCents: 1500,
        currency: 'EUR',
        idempotencyKey: 'pi_booking-1',
      }

      const first = await provider.createPaymentIntent(params)
      const replayed = await provider.createPaymentIntent(params)

      expect(mockStripe.paymentIntents.create.mock.calls[1][1]).toEqual({
        idempotencyKey: 'pi_booking-1',
      })
      expect(replayed.providerPaymentId).toBe(first.providerPaymentId)
      expect(replayed.clientSecret).toBe(first.clientSecret)
    })
  })

  describe('capturePayment', () => {
    beforeEach(() => {
      mockStripe.paymentIntents.capture.mockResolvedValue(
        intentResponse({ status: 'succeeded', client_secret: null }),
      )
    })

    it('captures with the idempotency key in the request options', async () => {
      const intent = await provider.capturePayment({
        providerPaymentId: 'pi_1',
        idempotencyKey: 'cap_booking-1',
      })

      expect(mockStripe.paymentIntents.capture).toHaveBeenCalledWith(
        'pi_1',
        {},
        { idempotencyKey: 'cap_booking-1' },
      )
      expect(intent.status).toBe('succeeded')
      expect(intent.clientSecret).toBeUndefined()
    })

    it('omits the idempotency key when the caller does not supply one', async () => {
      await provider.capturePayment({ providerPaymentId: 'pi_1' })

      expect(mockStripe.paymentIntents.capture).toHaveBeenCalledWith('pi_1', {}, {})
    })
  })

  describe('getPaymentStatus', () => {
    const cases: Array<[string, PaymentIntentStatus]> = [
      ['requires_payment_method', 'requires_payment'],
      ['requires_confirmation', 'requires_payment'],
      ['requires_action', 'requires_payment'],
      ['processing', 'processing'],
      ['requires_capture', 'requires_capture'],
      ['succeeded', 'succeeded'],
      ['canceled', 'canceled'],
    ]

    it.each(cases)('maps stripe status %s to %s', async (stripeStatus, expected) => {
      mockStripe.paymentIntents.retrieve.mockResolvedValue(intentResponse({ status: stripeStatus }))

      await expect(provider.getPaymentStatus('pi_1')).resolves.toBe(expected)
    })

    it('never maps an unrecognised status to succeeded', async () => {
      mockStripe.paymentIntents.retrieve.mockResolvedValue(
        intentResponse({ status: 'requires_teleportation' }),
      )

      const status = await provider.getPaymentStatus('pi_1')

      expect(status).not.toBe('succeeded')
      expect(status).toBe('processing')
    })
  })

  describe('refund', () => {
    beforeEach(() => {
      mockStripe.refunds.create.mockResolvedValue(refundResponse())
    })

    it('sends the idempotency key in the request options, never in the body', async () => {
      const result = await provider.refund({
        providerPaymentId: 'pi_1',
        amountCents: 1500,
        idempotencyKey: 'ref_booking-1',
      })

      const [body, options] = mockStripe.refunds.create.mock.calls[0]
      expect(body).toEqual({ payment_intent: 'pi_1', amount: 1500 })
      expect(body).not.toHaveProperty('idempotencyKey')
      expect(options).toEqual({ idempotencyKey: 'ref_booking-1' })
      expect(result).toEqual({ providerRefundId: 're_1', status: 'succeeded', amountCents: 1500 })
    })

    it('forwards a reason Stripe accepts', async () => {
      await provider.refund({
        providerPaymentId: 'pi_1',
        amountCents: 1500,
        idempotencyKey: 'ref_booking-1',
        reason: 'requested_by_customer',
      })

      const [body] = mockStripe.refunds.create.mock.calls[0]
      expect(body).toMatchObject({ reason: 'requested_by_customer' })
    })

    it('demotes a free-text reason to metadata so the refund still succeeds', async () => {
      await provider.refund({
        providerPaymentId: 'pi_1',
        amountCents: 1500,
        idempotencyKey: 'ref_booking-1',
        reason: 'operator cancelled the booking',
      })

      const [body] = mockStripe.refunds.create.mock.calls[0]
      expect(body).not.toHaveProperty('reason')
      expect(body).toMatchObject({ metadata: { reason: 'operator cancelled the booking' } })
    })

    it.each([
      ['succeeded', 'succeeded'],
      ['pending', 'pending'],
      ['requires_action', 'pending'],
      ['failed', 'failed'],
      ['canceled', 'failed'],
      [null, 'pending'],
    ])('maps refund status %s to %s', async (stripeStatus, expected) => {
      mockStripe.refunds.create.mockResolvedValue(refundResponse({ status: stripeStatus }))

      const result = await provider.refund({
        providerPaymentId: 'pi_1',
        amountCents: 1500,
        idempotencyKey: 'ref_booking-1',
      })

      expect(result.status).toBe(expected)
    })
  })

  describe('verifyWebhook', () => {
    it('refuses to verify when no webhook secret is configured', () => {
      const unconfigured = new StripeProvider({ secretKey: 'sk_test', webhookSecret: '' })

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

    it('normalizes a succeeded payment intent', () => {
      mockStripe.webhooks.constructEvent.mockReturnValue(
        event('payment_intent.succeeded', {
          id: 'pi_1',
          object: 'payment_intent',
          status: 'succeeded',
        }),
      )

      expect(provider.verifyWebhook('{}', 'sig')).toMatchObject({
        id: 'evt_1',
        type: 'payment_intent.succeeded',
        providerPaymentId: 'pi_1',
        status: 'succeeded',
      })
    })

    it('reports an authorized-but-uncaptured intent as requires_capture', () => {
      mockStripe.webhooks.constructEvent.mockReturnValue(
        event('payment_intent.amount_capturable_updated', {
          id: 'pi_1',
          object: 'payment_intent',
          status: 'requires_capture',
        }),
      )

      expect(provider.verifyWebhook('{}', 'sig').status).toBe('requires_capture')
    })

    it('reads failure from the event type, since the intent reverts to requires_payment_method', () => {
      mockStripe.webhooks.constructEvent.mockReturnValue(
        event('payment_intent.payment_failed', {
          id: 'pi_1',
          object: 'payment_intent',
          status: 'requires_payment_method',
        }),
      )

      expect(provider.verifyWebhook('{}', 'sig').status).toBe('failed')
    })

    it('exposes refund identifiers without claiming a payment status', () => {
      mockStripe.webhooks.constructEvent.mockReturnValue(
        event('refund.updated', {
          id: 're_1',
          object: 'refund',
          status: 'succeeded',
          payment_intent: 'pi_1',
        }),
      )

      const normalized = provider.verifyWebhook('{}', 'sig')

      expect(normalized.providerRefundId).toBe('re_1')
      expect(normalized.providerPaymentId).toBe('pi_1')
      expect(normalized.status).toBeUndefined()
    })

    it('does not report a refunded charge as a succeeded payment', () => {
      mockStripe.webhooks.constructEvent.mockReturnValue(
        event('charge.refunded', {
          id: 'ch_1',
          object: 'charge',
          status: 'succeeded',
          payment_intent: 'pi_1',
          refunds: { data: [{ id: 're_1' }] },
        }),
      )

      const normalized = provider.verifyWebhook('{}', 'sig')

      expect(normalized.status).toBeUndefined()
      expect(normalized.providerPaymentId).toBe('pi_1')
      expect(normalized.providerRefundId).toBe('re_1')
    })

    it('carries an unrelated event through without a status', () => {
      mockStripe.webhooks.constructEvent.mockReturnValue(
        event('customer.created', { id: 'cus_1', object: 'customer' }),
      )

      const normalized = provider.verifyWebhook('{}', 'sig')

      expect(normalized.status).toBeUndefined()
      expect(normalized.providerPaymentId).toBeUndefined()
    })
  })
})
