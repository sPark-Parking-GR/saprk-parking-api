import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createPaymentContext } from '@parqin/payments'
import type { PaymentProviderConfig } from '@parqin/payments'
import { PAYMENT_CONTEXT_TOKEN } from './payments.constants'
import { PaymentsService } from './payments.service'

@Module({
  providers: [
    {
      provide: PAYMENT_CONTEXT_TOKEN,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const provider = (config.get<string>('PAYMENT_PROVIDER') ?? 'mock') as PaymentProviderConfig['provider']

        switch (provider) {
          case 'mock':
            return createPaymentContext({ provider: 'mock', config: {} })
          case 'stripe':
            return createPaymentContext({
              provider: 'stripe',
              config: {
                secretKey: config.getOrThrow('STRIPE_SECRET_KEY'),
                webhookSecret: config.getOrThrow('STRIPE_WEBHOOK_SECRET'),
              },
            })
          default:
            throw new Error(`Unknown PAYMENT_PROVIDER: ${provider}`)
        }
      },
    },
    PaymentsService,
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
