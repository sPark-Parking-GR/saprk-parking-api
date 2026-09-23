import type {
  CheckoutSessionResult,
  CreateCheckoutSessionParams,
  CustomerResult,
  GetOrCreateCustomerParams,
  ISubscriptionBillingProvider,
  SubscriptionBillingWebhookEvent,
} from './ISubscriptionBillingProvider'
import { MockSubscriptionBillingProvider } from './providers/MockSubscriptionBillingProvider'

export class SubscriptionBillingContext {
  constructor(private provider: ISubscriptionBillingProvider) {}

  get providerName(): string {
    return this.provider.providerName
  }

  setProvider(provider: ISubscriptionBillingProvider): void {
    this.provider = provider
  }

  getOrCreateCustomer(params: GetOrCreateCustomerParams): Promise<CustomerResult> {
    return this.provider.getOrCreateCustomer(params)
  }

  createCheckoutSession(params: CreateCheckoutSessionParams): Promise<CheckoutSessionResult> {
    return this.provider.createCheckoutSession(params)
  }

  cancelSubscription(providerSubscriptionId: string): Promise<void> {
    return this.provider.cancelSubscription(providerSubscriptionId)
  }

  verifyWebhook(payload: Buffer | string, signature: string): SubscriptionBillingWebhookEvent {
    return this.provider.verifyWebhook(payload, signature)
  }

  /**
   * The stand-in checkout page has no hosted page to redirect to, so it drives the mock
   * provider's own session state directly. `null` on every real provider keeps that route
   * from doing anything on a deployment that takes actual money.
   */
  getMockProvider(): MockSubscriptionBillingProvider | null {
    return this.provider instanceof MockSubscriptionBillingProvider ? this.provider : null
  }
}
