import { Inject, Injectable } from '@nestjs/common'
import type {
  SubscriptionBillingContext,
  SubscriptionBillingWebhookEvent,
} from '@spark/subscription-billing'
import { OPERATOR_WEBHOOK_BILLING_CONTEXT_TOKEN } from './subscription-billing.constants'

/**
 * Signature verification for POST /operator-subscriptions/webhook, and NOTHING else.
 *
 * WHY it is not a method on SubscriptionBillingService. Stripe issues a signing secret per
 * ENDPOINT, and the driver and operator webhooks are two endpoints on one account. The secret
 * lives inside the provider instance, so verifying against the operator's secret means a
 * provider — and therefore a context — configured with it. This class owns that second
 * context and exposes only the one operation it exists for, so nothing can accidentally open
 * a checkout session or mint a customer against it.
 *
 * Everything with STATE stays on the single shared SubscriptionBillingService: customers,
 * checkout sessions and cancellations. That matters for the mock provider, whose sessions and
 * subscriptions are in-memory maps — a session opened by the operator checkout must be
 * resolvable by the operator mock-checkout page, and it is, because both reach the same
 * shared instance. Verification is pure (an HMAC over the payload and a JSON parse), so
 * splitting only it across a second instance costs nothing and shares nothing.
 */
@Injectable()
export class OperatorSubscriptionWebhookVerifier {
  constructor(
    @Inject(OPERATOR_WEBHOOK_BILLING_CONTEXT_TOKEN)
    private readonly billing: SubscriptionBillingContext,
  ) {}

  verifyWebhook(payload: Buffer | string, signature: string): SubscriptionBillingWebhookEvent {
    return this.billing.verifyWebhook(payload, signature)
  }
}
