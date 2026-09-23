import { createPaymentContext, createPaymentProvider } from './PaymentFactory'
import { MockPaymentProvider } from './providers/MockPaymentProvider'
import { StripeProvider } from './providers/StripeProvider'

describe('PaymentFactory', () => {
  it('creates a mock provider', () => {
    const provider = createPaymentProvider({ provider: 'mock', config: {} })
    expect(provider).toBeInstanceOf(MockPaymentProvider)
    expect(provider.providerName).toBe('mock')
  })

  it('creates a stripe provider', () => {
    const provider = createPaymentProvider({
      provider: 'stripe',
      config: { secretKey: 'sk_test', webhookSecret: 'whsec' },
    })
    expect(provider).toBeInstanceOf(StripeProvider)
    expect(provider.providerName).toBe('stripe')
  })

  it('wraps the provider in a context that delegates', async () => {
    const context = createPaymentContext({ provider: 'mock', config: {} })
    expect(context.providerName).toBe('mock')
    const intent = await context.createPaymentIntent({
      amountCents: 100,
      currency: 'EUR',
      idempotencyKey: 'k',
    })
    expect(intent.amountCents).toBe(100)
  })
})
