import { BadRequestException, Controller, Headers, HttpCode, Post, Req } from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import type { PaymentWebhookEvent } from '@spark/types'
import { Public } from '../auth/decorators/public.decorator'
import { PaymentsService } from '../payments/payments.service'
import { PaymentEventsService } from './payment-events.service'

type RawBodyRequest = FastifyRequest & { rawBody?: Buffer }

@Controller('payments')
export class PaymentsWebhookController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly paymentEvents: PaymentEventsService,
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

    let event: PaymentWebhookEvent
    try {
      event = this.payments.verifyWebhook(payload, signature ?? '')
    } catch {
      // 400, not 500: an unverifiable payload will never verify on redelivery either,
      // so asking the provider to retry it would loop forever.
      throw new BadRequestException('Webhook signature verification failed')
    }

    await this.paymentEvents.process(event)

    return { received: true }
  }
}
