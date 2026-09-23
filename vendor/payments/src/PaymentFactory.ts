import { PaymentContext } from './PaymentContext'
import type { IPaymentProvider } from './IPaymentProvider'
import { MockPaymentProvider } from './providers/MockPaymentProvider'
import { StripeProvider } from './providers/StripeProvider'
import type { MockPaymentConfig } from './providers/MockPaymentProvider'
import type { StripeConfig } from './providers/StripeProvider'

export type PaymentProviderConfig =
  { provider: 'stripe'; config: StripeConfig } | { provider: 'mock'; config?: MockPaymentConfig }

export function createPaymentProvider(options: PaymentProviderConfig): IPaymentProvider {
  switch (options.provider) {
    case 'stripe':
      return new StripeProvider(options.config)
    case 'mock':
      return new MockPaymentProvider(options.config)
  }
}

export function createPaymentContext(options: PaymentProviderConfig): PaymentContext {
  return new PaymentContext(createPaymentProvider(options))
}
