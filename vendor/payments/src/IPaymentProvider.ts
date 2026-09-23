import type {
  CapturePaymentParams,
  CreatePaymentIntentParams,
  PaymentIntent,
  PaymentIntentStatus,
  PaymentWebhookEvent,
  RefundParams,
  RefundResult,
} from '@spark/types'

export interface IPaymentProvider {
  readonly providerName: string

  createPaymentIntent(params: CreatePaymentIntentParams): Promise<PaymentIntent>

  capturePayment(params: CapturePaymentParams): Promise<PaymentIntent>

  getPaymentStatus(providerPaymentId: string): Promise<PaymentIntentStatus>

  refund(params: RefundParams): Promise<RefundResult>

  verifyWebhook(payload: Buffer | string, signature: string): PaymentWebhookEvent
}
