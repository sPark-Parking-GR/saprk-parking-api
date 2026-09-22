import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createSubscriptionBillingContext } from '@spark/subscription-billing'
import type { SubscriptionBillingProviderConfig } from '@spark/subscription-billing'
import { OperatorSubscriptionWebhookVerifier } from './operator-subscription-webhook.verifier'
import {
  OPERATOR_WEBHOOK_BILLING_CONTEXT_TOKEN,
  SUBSCRIPTION_BILLING_CONTEXT_TOKEN,
} from './subscription-billing.constants'
import { SubscriptionBillingService } from './subscription-billing.service'

/**
 * The mock provider's stand-in checkout page is served by THIS api, so the URL it hands the
 * client has to carry main.ts's global prefix — nothing exempts the mock-checkout routes
 * from it. API_PUBLIC_URL is the bare origin (per .env.example), so the prefix is appended
 * here rather than expected from the deployer, who would otherwise have to know an internal
 * routing detail to configure the app correctly.
 */
function mockCheckoutBaseUrl(apiPublicUrl: string): string {
  return `${apiPublicUrl.replace(/\/+$/, '')}/api/v1`
}

/**
 * `webhookSecretKey` names which Stripe endpoint secret the context verifies against. Every
 * other input is identical, which is the point: the two contexts talk to the same provider,
 * the same account and the same catalog, and differ only in whose signature they trust.
 */
function contextFactory(webhookSecretKey: string) {
  return (config: ConfigService) => {
    const provider = (config.get<string>('SUBSCRIPTION_BILLING_PROVIDER') ??
      'mock') as SubscriptionBillingProviderConfig['provider']

    switch (provider) {
      case 'mock':
        return createSubscriptionBillingContext({
          provider: 'mock',
          config: {
            mockCheckoutBaseUrl: mockCheckoutBaseUrl(config.getOrThrow('API_PUBLIC_URL')),
            // One secret for both routes: the mock has no per-endpoint registration to
            // mirror, and a second local secret would be ceremony with nothing behind it.
            webhookSecret: config.getOrThrow('MOCK_SUBSCRIPTION_WEBHOOK_SECRET'),
          },
        })
      case 'stripe':
        return createSubscriptionBillingContext({
          provider: 'stripe',
          config: {
            // The same Stripe account as one-shot payments; only the endpoint signing
            // secret differs, because Stripe issues one per webhook endpoint.
            secretKey: config.getOrThrow('STRIPE_SECRET_KEY'),
            webhookSecret: config.getOrThrow(webhookSecretKey),
          },
        })
      default:
        throw new Error(`Unknown SUBSCRIPTION_BILLING_PROVIDER: ${provider}`)
    }
  }
}

@Module({
  providers: [
    {
      provide: SUBSCRIPTION_BILLING_CONTEXT_TOKEN,
      inject: [ConfigService],
      useFactory: contextFactory('STRIPE_SUBSCRIPTION_WEBHOOK_SECRET'),
    },
    {
      // Verification only — see OperatorSubscriptionWebhookVerifier. Deliberately NOT a
      // second engine: every stateful operation stays on the shared context above, so the
      // mock provider's in-memory sessions have exactly one home.
      provide: OPERATOR_WEBHOOK_BILLING_CONTEXT_TOKEN,
      inject: [ConfigService],
      useFactory: contextFactory('STRIPE_OPERATOR_WEBHOOK_SECRET'),
    },
    SubscriptionBillingService,
    OperatorSubscriptionWebhookVerifier,
  ],
  exports: [SubscriptionBillingService, OperatorSubscriptionWebhookVerifier],
})
export class SubscriptionBillingModule {}
