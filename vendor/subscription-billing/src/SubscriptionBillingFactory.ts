import { SubscriptionBillingContext } from './SubscriptionBillingContext'
import type { ISubscriptionBillingProvider } from './ISubscriptionBillingProvider'
import { MockSubscriptionBillingProvider } from './providers/MockSubscriptionBillingProvider'
import { StripeSubscriptionBillingProvider } from './providers/StripeSubscriptionBillingProvider'
import type { MockSubscriptionBillingConfig } from './providers/MockSubscriptionBillingProvider'
import type { StripeSubscriptionBillingConfig } from './providers/StripeSubscriptionBillingProvider'

export type SubscriptionBillingProviderConfig =
  | { provider: 'stripe'; config: StripeSubscriptionBillingConfig }
  | { provider: 'mock'; config: MockSubscriptionBillingConfig }

export function createSubscriptionBillingProvider(
  options: SubscriptionBillingProviderConfig,
): ISubscriptionBillingProvider {
  switch (options.provider) {
    case 'stripe':
      return new StripeSubscriptionBillingProvider(options.config)
    case 'mock':
      return new MockSubscriptionBillingProvider(options.config)
  }
}

export function createSubscriptionBillingContext(
  options: SubscriptionBillingProviderConfig,
): SubscriptionBillingContext {
  return new SubscriptionBillingContext(createSubscriptionBillingProvider(options))
}
