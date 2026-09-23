import {
  createSubscriptionBillingContext,
  createSubscriptionBillingProvider,
} from './SubscriptionBillingFactory'
import { MockSubscriptionBillingProvider } from './providers/MockSubscriptionBillingProvider'
import { StripeSubscriptionBillingProvider } from './providers/StripeSubscriptionBillingProvider'

const mockConfig = { mockCheckoutBaseUrl: 'http://localhost:3010' }

describe('SubscriptionBillingFactory', () => {
  it('creates a mock provider', () => {
    const provider = createSubscriptionBillingProvider({ provider: 'mock', config: mockConfig })
    expect(provider).toBeInstanceOf(MockSubscriptionBillingProvider)
    expect(provider.providerName).toBe('mock')
  })

  it('creates a stripe provider', () => {
    const provider = createSubscriptionBillingProvider({
      provider: 'stripe',
      config: { secretKey: 'sk_test', webhookSecret: 'whsec' },
    })
    expect(provider).toBeInstanceOf(StripeSubscriptionBillingProvider)
    expect(provider.providerName).toBe('stripe')
  })

  it('wraps the provider in a context that delegates', async () => {
    const context = createSubscriptionBillingContext({ provider: 'mock', config: mockConfig })

    expect(context.providerName).toBe('mock')
    const customer = await context.getOrCreateCustomer({
      subscriber: { type: 'driver', id: 'user-1' },
      email: 'rider@example.com',
    })
    expect(customer.providerCustomerId).toMatch(/^cus_mock_/)
  })

  it('exposes the mock-only checkout hooks through the context', async () => {
    const context = createSubscriptionBillingContext({ provider: 'mock', config: mockConfig })
    const mock = context.getMockProvider()
    expect(mock).toBeInstanceOf(MockSubscriptionBillingProvider)

    const session = await context.createCheckoutSession({
      providerCustomerId: 'cus_mock_1',
      subscriber: { type: 'driver', id: 'user-1' },
      planId: 'plan-1',
      planCode: 'DRIVER_PLUS',
      priceCents: 499,
      currency: 'EUR',
      interval: 'MONTHLY',
      successUrl: 'spark://ok',
      cancelUrl: 'spark://cancel',
    })

    expect(mock!.getCheckoutSession(session.checkoutSessionId)?.status).toBe('open')
    expect(mock!.completeCheckoutSession(session.checkoutSessionId).type).toBe('checkout.completed')
  })

  it('hands out no mock hooks on a provider that takes real money', () => {
    const context = createSubscriptionBillingContext({
      provider: 'stripe',
      config: { secretKey: 'sk_test', webhookSecret: 'whsec' },
    })

    expect(context.getMockProvider()).toBeNull()
  })

  it('swaps the underlying provider', () => {
    const context = createSubscriptionBillingContext({ provider: 'mock', config: mockConfig })

    context.setProvider(
      createSubscriptionBillingProvider({
        provider: 'stripe',
        config: { secretKey: 'sk_test', webhookSecret: 'whsec' },
      }),
    )

    expect(context.providerName).toBe('stripe')
  })
})
