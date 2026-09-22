import { BadRequestException, Controller, Headers, HttpCode, Post, Req } from '@nestjs/common'
import { Logger } from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import {
  UnsupportedSubscriptionBillingEventError,
  type SubscriptionBillingWebhookEvent,
} from '@spark/subscription-billing'
import { Public } from '../auth/decorators/public.decorator'
import { SubscriptionBillingService } from '../subscription-billing/subscription-billing.service'
import { DriverSubscriptionEventsService } from './driver-subscription-events.service'

type RawBodyRequest = FastifyRequest & { rawBody?: Buffer }

/**
 * The subscription counterpart of PaymentsWebhookController, on its own path because Stripe
 * signs per endpoint: this route verifies against STRIPE_SUBSCRIPTION_WEBHOOK_SECRET and the
 * payments route against STRIPE_WEBHOOK_SECRET, and a delivery to the wrong one must fail.
 * The header name is `stripe-signature` on both — Stripe uses it for every endpoint whatever
 * the endpoint is for.
 */
@Controller('driver-subscriptions')
export class DriverSubscriptionsWebhookController {
  private readonly logger = new Logger(DriverSubscriptionsWebhookController.name)

  constructor(
    private readonly billing: SubscriptionBillingService,
    private readonly events: DriverSubscriptionEventsService,
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
      event = this.billing.verifyWebhook(payload, signature ?? '')
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
