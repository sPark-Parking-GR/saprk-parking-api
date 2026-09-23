import type {
  CapturePaymentParams,
  CreatePaymentIntentParams,
  PaymentIntent,
  PaymentIntentStatus,
  PaymentWebhookEvent,
  RefundParams,
  RefundResult,
} from '@spark/types'
import type { IPaymentProvider } from './IPaymentProvider'

export class PaymentContext {
  constructor(private provider: IPaymentProvider) {}

  get providerName(): string {
    return this.provider.providerName
  }

  setProvider(provider: IPaymentProvider): void {
    this.provider = provider
  }

  createPaymentIntent(params: CreatePaymentIntentParams): Promise<PaymentIntent> {
    return this.provider.createPaymentIntent(params)
  }

  capturePayment(params: CapturePaymentParams): Promise<PaymentIntent> {
    return this.provider.capturePayment(params)
  }

  getPaymentStatus(providerPaymentId: string): Promise<PaymentIntentStatus> {
    return this.provider.getPaymentStatus(providerPaymentId)
  }

  refund(params: RefundParams): Promise<RefundResult> {
    return this.provider.refund(params)
  }

  verifyWebhook(payload: Buffer | string, signature: string): PaymentWebhookEvent {
    return this.provider.verifyWebhook(payload, signature)
  }
}
