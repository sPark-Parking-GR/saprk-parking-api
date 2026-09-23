import Stripe from 'stripe'
import { StripeProvider } from './StripeProvider'

const secret = 'whsec_test_secret'
const stripe = new Stripe('sk_test_123', { apiVersion: '2025-02-24.acacia' })

const payload = JSON.stringify({
  id: 'evt_1',
  object: 'event',
  type: 'payment_intent.succeeded',
  data: { object: { id: 'pi_1', object: 'payment_intent', status: 'succeeded' } },
})

describe('StripeProvider webhook signature verification', () => {
  const provider = new StripeProvider({ secretKey: 'sk_test_123', webhookSecret: secret })

  it('accepts a genuinely signed payload', () => {
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret })

    const event = provider.verifyWebhook(payload, signature)

    expect(event.id).toBe('evt_1')
    expect(event.providerPaymentId).toBe('pi_1')
    expect(event.status).toBe('succeeded')
  })

  it('rejects a payload tampered with after signing', () => {
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret })
    const tampered = payload.replace('pi_1', 'pi_attacker')

    expect(() => provider.verifyWebhook(tampered, signature)).toThrow(
      Stripe.errors.StripeSignatureVerificationError,
    )
  })

  it('rejects a signature made with another secret', () => {
    const forged = stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_attacker' })

    expect(() => provider.verifyWebhook(payload, forged)).toThrow(
      Stripe.errors.StripeSignatureVerificationError,
    )
  })

  it('rejects a missing signature', () => {
    expect(() => provider.verifyWebhook(payload, '')).toThrow(
      Stripe.errors.StripeSignatureVerificationError,
    )
  })

  it('rejects a replayed signature outside the tolerance window', () => {
    const stale = stripe.webhooks.generateTestHeaderString({
      payload,
      secret,
      timestamp: Math.floor(Date.now() / 1000) - 60 * 60,
    })

    expect(() => provider.verifyWebhook(payload, stale)).toThrow(
      Stripe.errors.StripeSignatureVerificationError,
    )
  })
})
