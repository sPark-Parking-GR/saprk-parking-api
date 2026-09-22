import { Inject, Injectable } from '@nestjs/common'
import type { PaymentContext } from '@spark/payments'
import type {
  CapturePaymentParams,
  CreatePaymentIntentParams,
  PaymentIntent,
  PaymentWebhookEvent,
  RefundParams,
  RefundResult,
} from '@spark/types'
import { PAYMENT_CONTEXT_TOKEN } from './payments.constants'

@Injectable()
export class PaymentsService {
  constructor(@Inject(PAYMENT_CONTEXT_TOKEN) private readonly payments: PaymentContext) {}

  get providerName(): string {
    return this.payments.providerName
  }

  createPaymentIntent(params: CreatePaymentIntentParams): Promise<PaymentIntent> {
    return this.payments.createPaymentIntent(params)
  }

  capturePayment(params: CapturePaymentParams): Promise<PaymentIntent> {
    return this.payments.capturePayment(params)
  }

  refund(params: RefundParams): Promise<RefundResult> {
    return this.payments.refund(params)
  }

  verifyWebhook(payload: Buffer | string, signature: string): PaymentWebhookEvent {
    return this.payments.verifyWebhook(payload, signature)
  }
}
