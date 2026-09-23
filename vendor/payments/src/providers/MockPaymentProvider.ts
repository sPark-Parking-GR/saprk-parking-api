import { createHmac, randomUUID, timingSafeEqual } from 'crypto'
import type {
  CapturePaymentParams,
  CreatePaymentIntentParams,
  PaymentIntent,
  PaymentIntentStatus,
  PaymentWebhookEvent,
  RefundParams,
  RefundResult,
} from '@spark/types'
import type { IPaymentProvider } from '../IPaymentProvider'

interface MockRecord {
  amountCents: number
  currency: string
  status: PaymentIntentStatus
}

export interface MockPaymentConfig {
  webhookSecret?: string
}

export class MockPaymentProvider implements IPaymentProvider {
  readonly providerName = 'mock'

  private readonly store = new Map<string, MockRecord>()
  private readonly intentsByIdempotencyKey = new Map<string, string>()

  constructor(private readonly config: MockPaymentConfig = {}) {}

  async createPaymentIntent(params: CreatePaymentIntentParams): Promise<PaymentIntent> {
    const existingId = this.intentsByIdempotencyKey.get(params.idempotencyKey)
    if (existingId) {
      const existing = this.store.get(existingId)!
      return this.toIntent(existingId, existing)
    }

    const id = `mock_pi_${randomUUID()}`
    const record: MockRecord = {
      amountCents: params.amountCents,
      currency: params.currency,
      status: 'requires_payment',
    }
    this.store.set(id, record)
    this.intentsByIdempotencyKey.set(params.idempotencyKey, id)

    return { ...this.toIntent(id, record), clientSecret: `${id}_secret_mock` }
  }

  async capturePayment(params: CapturePaymentParams): Promise<PaymentIntent> {
    const record = this.store.get(params.providerPaymentId)
    if (!record) throw new Error(`MockPaymentProvider: unknown payment ${params.providerPaymentId}`)

    record.status = 'succeeded'
    return this.toIntent(params.providerPaymentId, record)
  }

  async getPaymentStatus(providerPaymentId: string): Promise<PaymentIntentStatus> {
    const record = this.store.get(providerPaymentId)
    if (!record) throw new Error(`MockPaymentProvider: unknown payment ${providerPaymentId}`)
    return record.status
  }

  async refund(params: RefundParams): Promise<RefundResult> {
    const record = this.store.get(params.providerPaymentId)
    if (!record) throw new Error(`MockPaymentProvider: unknown payment ${params.providerPaymentId}`)

    record.status = 'canceled'
    return {
      providerRefundId: `mock_re_${randomUUID()}`,
      status: 'succeeded',
      amountCents: params.amountCents,
    }
  }

  static sign(payload: Buffer | string, secret: string): string {
    return createHmac('sha256', secret).update(payload).digest('hex')
  }

  verifyWebhook(payload: Buffer | string, signature: string): PaymentWebhookEvent {
    // Fail closed. `mock` is the default provider and its webhook route is public, so an
    // unconfigured secret has to make the endpoint unusable rather than unauthenticated.
    if (!this.config.webhookSecret) {
      throw new Error('MockPaymentProvider.verifyWebhook: webhookSecret is not configured')
    }

    const expected = Buffer.from(MockPaymentProvider.sign(payload, this.config.webhookSecret))
    const received = Buffer.from(signature)
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      throw new Error('MockPaymentProvider.verifyWebhook: signature mismatch')
    }

    const text = typeof payload === 'string' ? payload : payload.toString('utf8')
    const parsed = JSON.parse(text) as {
      id?: string
      type?: string
      providerPaymentId?: string
      providerRefundId?: string
      status?: PaymentIntentStatus
    }

    return {
      id: parsed.id ?? `mock_evt_${randomUUID()}`,
      type: parsed.type ?? 'payment.succeeded',
      providerPaymentId: parsed.providerPaymentId,
      providerRefundId: parsed.providerRefundId,
      status: parsed.status ?? 'succeeded',
      raw: parsed,
    }
  }

  private toIntent(id: string, record: MockRecord): PaymentIntent {
    return {
      providerPaymentId: id,
      status: record.status,
      amountCents: record.amountCents,
      currency: record.currency,
    }
  }
}
