export type PaymentProviderName = 'stripe' | 'mock'

export type PaymentIntentStatus =
  | 'requires_payment'
  // Funds are authorized and held but not yet taken. Bookings are captured at confirm
  // time, so this is the state a booking sits in between authorization and capture.
  | 'requires_capture'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'canceled'

export type RefundStatusType = 'pending' | 'succeeded' | 'failed'

export interface CreatePaymentIntentParams {
  amountCents: number
  currency: string
  idempotencyKey: string
  description?: string
  metadata?: Record<string, string>
}

export interface PaymentIntent {
  providerPaymentId: string
  clientSecret?: string
  status: PaymentIntentStatus
  amountCents: number
  currency: string
}

export interface CapturePaymentParams {
  providerPaymentId: string
  idempotencyKey?: string
}

export interface RefundParams {
  providerPaymentId: string
  amountCents: number
  idempotencyKey: string
  reason?: string
}

export interface RefundResult {
  providerRefundId: string
  status: RefundStatusType
  amountCents: number
}

export interface PaymentWebhookEvent {
  id: string
  type: string
  providerPaymentId?: string
  // Present on refund events, where the payment id alone cannot identify which refund
  // the notification is about.
  providerRefundId?: string
  status?: PaymentIntentStatus
  raw: unknown
}
