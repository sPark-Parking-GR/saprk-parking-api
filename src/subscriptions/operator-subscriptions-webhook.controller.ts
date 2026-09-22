import { BadRequestException, Controller, Headers, HttpCode, Logger, Post, Req } from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import {
  UnsupportedSubscriptionBillingEventError,
  type SubscriptionBillingWebhookEvent,
} from '@spark/subscription-billing'
import { Public } from '../auth/decorators/public.decorator'
import { OperatorSubscriptionWebhookVerifier } from '../subscription-billing/operator-subscription-webhook.verifier'
import { OperatorSubscriptionEventsService } from './operator-subscription-events.service'

type RawBodyRequest = FastifyRequest & { rawBody?: Buffer }

/**
 * The operator counterpart of DriverSubscriptionsWebhookController, on its own path because
 * Stripe signs per endpoint: this route verifies against STRIPE_OPERATOR_WEBHOOK_SECRET, the
 * driver route against STRIPE_SUBSCRIPTION_WEBHOOK_SECRET and the payments route against
 * STRIPE_WEBHOOK_SECRET, and a delivery to the wrong one must fail. That is why verification
 * comes from OperatorSubscriptionWebhookVerifier rather than the shared
 * SubscriptionBillingService — the secret is per endpoint, and only this one's is trusted
 * here. The header name is `stripe-signature` on all three; Stripe uses it for every endpoint
 * whatever the endpoint is for.
 */
@Controller('operator-subscriptions')
export class OperatorSubscriptionsWebhookController {
  private readonly logger = new Logger(OperatorSubscriptionsWebhookController.name)

  constructor(
    private readonly verifier: OperatorSubscriptionWebhookVerifier,
    private readonly events: OperatorSubscriptionEventsService,
  ) {}

  @Public()
  @HttpCode(200)
  @Post('webhook')
  async handle(
    @Req() request: RawBodyRequest,
    @Headers('stripe-signature') signature: string | undefined,
  ) {
    const payload = request.rawBody
    if (!payload) throw new BadRequestException('Missing raw request body')

    let event: SubscriptionBillingWebhookEvent
    try {
      event = this.verifier.verifyWebhook(payload, signature ?? '')
    } catch (error) {
      // A signature-verified event this engine does not model. 200, not 4xx: the payload is
      // genuine and simply not ours to act on, and refusing it would make Stripe redeliver
      // forever and eventually disable the endpoint — taking the subscription events that DO
      // matter down with it.
      if (error instanceof UnsupportedSubscriptionBillingEventError) {
        this.logger.log(`Ignoring unmodelled subscription billing event ${error.eventType}`)
        return { received: true, ignored: true }
      }
      // 400, not 500: an unverifiable payload will never verify on redelivery either,
      // so asking the provider to retry it would loop forever.
      throw new BadRequestException('Webhook signature verification failed')
    }

    await this.events.process(event)

    return { received: true }
  }
}
