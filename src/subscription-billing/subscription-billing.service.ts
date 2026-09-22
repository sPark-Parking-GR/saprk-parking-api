import { Inject, Injectable, Logger } from '@nestjs/common'
import type {
  CheckoutSessionResult,
  CreateCheckoutSessionParams,
  CustomerResult,
  GetOrCreateCustomerParams,
  MockSubscriptionBillingProvider,
  SubscriptionBillingContext,
  SubscriptionBillingWebhookEvent,
} from '@spark/subscription-billing'
import { SUBSCRIPTION_BILLING_CONTEXT_TOKEN } from './subscription-billing.constants'

@Injectable()
export class SubscriptionBillingService {
  private readonly logger = new Logger(SubscriptionBillingService.name)

  constructor(
    @Inject(SUBSCRIPTION_BILLING_CONTEXT_TOKEN)
    private readonly billing: SubscriptionBillingContext,
  ) {}

  get providerName(): string {
    return this.billing.providerName
  }

  getOrCreateCustomer(params: GetOrCreateCustomerParams): Promise<CustomerResult> {
    return this.billing.getOrCreateCustomer(params)
  }

  createCheckoutSession(params: CreateCheckoutSessionParams): Promise<CheckoutSessionResult> {
    return this.billing.createCheckoutSession(params)
  }

  cancelSubscription(providerSubscriptionId: string): Promise<void> {
    return this.billing.cancelSubscription(providerSubscriptionId)
  }

  /**
   * Cancel at the provider without letting the provider veto a local write that has already
   * been decided — the same failure-tolerance NotificationsService.safeSend applies to email.
   *
   * The callers are an administrator's override and a rider's completed purchase. Neither may
   * be blocked by a transient Stripe outage, and neither may fail silently either: `false`
   * says the subscription is still live upstream, and the caller is expected to leave a
   * durable trail of that rather than discard the answer.
   */
  async cancelSubscriptionBestEffort(
    providerSubscriptionId: string,
    context: Record<string, unknown> = {},
  ): Promise<boolean> {
    try {
      await this.billing.cancelSubscription(providerSubscriptionId)
      return true
    } catch (error) {
      this.logger.error(
        {
          ...context,
          provider: this.billing.providerName,
          providerSubscriptionId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to cancel subscription at the billing provider; it may still be charging',
      )
      return false
    }
  }

  verifyWebhook(payload: Buffer | string, signature: string): SubscriptionBillingWebhookEvent {
    return this.billing.verifyWebhook(payload, signature)
  }

  /** Null on every real provider; see SubscriptionBillingContext.getMockProvider. */
  getMockProvider(): MockSubscriptionBillingProvider | null {
    return this.billing.getMockProvider()
  }
}
