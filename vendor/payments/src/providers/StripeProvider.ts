import Stripe from 'stripe'
import type {
  CapturePaymentParams,
  CreatePaymentIntentParams,
  PaymentIntent,
  PaymentIntentStatus,
  PaymentWebhookEvent,
  RefundParams,
  RefundResult,
  RefundStatusType,
} from '@spark/types'
import type { IPaymentProvider } from '../IPaymentProvider'

export interface StripeConfig {
  secretKey: string
  webhookSecret: string
}

// Pinned so an SDK upgrade cannot silently change request or response shapes on a live
// payment flow. Bump deliberately, with the Stripe upgrade notes.
const STRIPE_API_VERSION = '2025-02-24.acacia'

const INTENT_STATUS: Record<Stripe.PaymentIntent.Status, PaymentIntentStatus> = {
  requires_payment_method: 'requires_payment',
  requires_confirmation: 'requires_payment',
  requires_action: 'requires_payment',
  processing: 'processing',
  requires_capture: 'requires_capture',
  succeeded: 'succeeded',
  canceled: 'canceled',
}

function mapIntentStatus(status: string): PaymentIntentStatus {
  const known: PaymentIntentStatus | undefined =
    INTENT_STATUS[status as Stripe.PaymentIntent.Status]
  // A status Stripe added after this pin stays non-terminal: re-polling is recoverable,
  // where guessing a terminal state either confirms an unpaid booking or voids a paid one.
  return known ?? 'processing'
}

function mapRefundStatus(status: string | null): RefundStatusType {
  switch (status) {
    case 'succeeded':
      return 'succeeded'
    case 'failed':
    case 'canceled':
      return 'failed'
    default:
      return 'pending'
  }
}

function isStripeRefundReason(reason?: string): reason is Stripe.RefundCreateParams.Reason {
  return reason === 'duplicate' || reason === 'fraudulent' || reason === 'requested_by_customer'
}

function referencedId(ref: string | { id: string } | null): string | undefined {
  if (!ref) return undefined
  return typeof ref === 'string' ? ref : ref.id
}

export class StripeProvider implements IPaymentProvider {
  readonly providerName = 'stripe'

  private readonly stripe: Stripe

  constructor(private readonly config: StripeConfig) {
    this.stripe = new Stripe(config.secretKey, { apiVersion: STRIPE_API_VERSION })
  }

  async createPaymentIntent(params: CreatePaymentIntentParams): Promise<PaymentIntent> {
    const intent = await this.stripe.paymentIntents.create(
      {
        amount: params.amountCents,
        currency: params.currency.toLowerCase(),
        // Hold now, take the money at booking confirmation.
        capture_method: 'manual',
        description: params.description,
        metadata: params.metadata,
      },
      // Idempotency belongs in the request options, never the body: Stripe stores the first
      // response per key and replays it verbatim, so a retried booking authorizes once and
      // still gets its client_secret back.
      { idempotencyKey: params.idempotencyKey },
    )

    return this.toIntent(intent)
  }

  async capturePayment(params: CapturePaymentParams): Promise<PaymentIntent> {
    const options: Stripe.RequestOptions = {}
    if (params.idempotencyKey) options.idempotencyKey = params.idempotencyKey

    const intent = await this.stripe.paymentIntents.capture(params.providerPaymentId, {}, options)

    return this.toIntent(intent)
  }

  async getPaymentStatus(providerPaymentId: string): Promise<PaymentIntentStatus> {
    const intent = await this.stripe.paymentIntents.retrieve(providerPaymentId)
    return mapIntentStatus(intent.status)
  }

  async refund(params: RefundParams): Promise<RefundResult> {
    const createParams: Stripe.RefundCreateParams = {
      payment_intent: params.providerPaymentId,
      amount: params.amountCents,
    }
    // Stripe accepts only three reason values; free text would be rejected outright, so it
    // travels as metadata instead of failing the refund.
    if (isStripeRefundReason(params.reason)) createParams.reason = params.reason
    else if (params.reason) createParams.metadata = { reason: params.reason }

    const refund = await this.stripe.refunds.create(createParams, {
      idempotencyKey: params.idempotencyKey,
    })

    return {
      providerRefundId: refund.id,
      status: mapRefundStatus(refund.status),
      amountCents: refund.amount,
    }
  }

  verifyWebhook(payload: Buffer | string, signature: string): PaymentWebhookEvent {
    // An empty secret still produces a verifiable HMAC, so an unconfigured endpoint must
    // refuse outright rather than accept anything signed with ''.
    if (!this.config.webhookSecret) {
      throw new Error('StripeProvider.verifyWebhook: webhookSecret is not configured')
    }

    const event = this.stripe.webhooks.constructEvent(payload, signature, this.config.webhookSecret)

    return this.normalize(event)
  }

  private normalize(event: Stripe.Event): PaymentWebhookEvent {
    const base = { id: event.id, type: event.type, raw: event }
    const object = event.data.object as { object?: string }

    switch (object.object) {
      case 'payment_intent': {
        const intent = event.data.object as Stripe.PaymentIntent
        return {
          ...base,
          providerPaymentId: intent.id,
          // A failed intent reverts to requires_payment_method, so the event type is the only
          // place the failure is visible.
          status:
            event.type === 'payment_intent.payment_failed'
              ? 'failed'
              : mapIntentStatus(intent.status),
        }
      }
      // Refund events carry no payment status on purpose: a refunded charge still reads
      // `succeeded`, which downstream would read as a successful payment.
      case 'refund': {
        const refund = event.data.object as Stripe.Refund
        return {
          ...base,
          providerPaymentId: referencedId(refund.payment_intent),
          providerRefundId: refund.id,
        }
      }
      case 'charge': {
        const charge = event.data.object as Stripe.Charge
        return {
          ...base,
          providerPaymentId: referencedId(charge.payment_intent),
          providerRefundId: charge.refunds?.data[0]?.id,
        }
      }
      default:
        return base
    }
  }

  private toIntent(intent: Stripe.PaymentIntent): PaymentIntent {
    return {
      providerPaymentId: intent.id,
      clientSecret: intent.client_secret ?? undefined,
      status: mapIntentStatus(intent.status),
      amountCents: intent.amount,
      currency: intent.currency,
    }
  }
}
