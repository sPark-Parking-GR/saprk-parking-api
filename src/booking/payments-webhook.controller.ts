import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
} from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import { Public } from '../auth/decorators/public.decorator'
import { PaymentsService } from '../payments/payments.service'
import { BookingService } from './booking.service'

type RawBodyRequest = FastifyRequest & { rawBody?: Buffer }

@Controller('payments')
export class PaymentsWebhookController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly bookings: BookingService,
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

    const event = this.payments.verifyWebhook(payload, signature ?? '')

    if (event.status === 'succeeded' && event.providerPaymentId) {
      await this.bookings.confirmByProviderPaymentId(event.providerPaymentId)
    }

    return { received: true }
  }
}
