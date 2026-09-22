import { BadRequestException } from '@nestjs/common'
import type { PaymentWebhookEvent } from '@spark/types'
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator'
import type { PaymentsService } from '../payments/payments.service'
import type { PaymentEventsService } from './payment-events.service'
import { PaymentsWebhookController } from './payments-webhook.controller'

const event: PaymentWebhookEvent = {
  id: 'evt_1',
  type: 'payment_intent.succeeded',
  providerPaymentId: 'pi_1',
  status: 'succeeded',
  raw: {},
}

type WebhookRequest = Parameters<PaymentsWebhookController['handle']>[0]

const requestWith = (rawBody?: Buffer): WebhookRequest => ({ rawBody }) as unknown as WebhookRequest

describe('PaymentsWebhookController', () => {
  let payments: { verifyWebhook: jest.Mock }
  let paymentEvents: { process: jest.Mock }
  let controller: PaymentsWebhookController

  beforeEach(() => {
    payments = { verifyWebhook: jest.fn().mockReturnValue(event) }
    paymentEvents = { process: jest.fn().mockResolvedValue('processed') }
    controller = new PaymentsWebhookController(
      payments as unknown as PaymentsService,
      paymentEvents as unknown as PaymentEventsService,
    )
  })

  it('stays public: the provider authenticates via signature, not a session', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, PaymentsWebhookController.prototype.handle)).toBe(
      true,
    )
  })

  it('rejects a missing raw body with 400 before verifying anything', async () => {
    await expect(controller.handle(requestWith(undefined), 'sig')).rejects.toBeInstanceOf(
      BadRequestException,
    )
    expect(payments.verifyWebhook).not.toHaveBeenCalled()
  })

  it('maps a signature verification failure to 400, not a retriable 500', async () => {
    payments.verifyWebhook.mockImplementation(() => {
      throw new Error('bad signature')
    })

    await expect(controller.handle(requestWith(Buffer.from('{}')), 'sig')).rejects.toBeInstanceOf(
      BadRequestException,
    )
    expect(paymentEvents.process).not.toHaveBeenCalled()
  })

  it('acknowledges a verified event and hands it to the event processor', async () => {
    await expect(controller.handle(requestWith(Buffer.from('{}')), 'sig')).resolves.toEqual({
      received: true,
    })
    expect(paymentEvents.process).toHaveBeenCalledWith(event)
  })

  it('returns 200 for a redelivered event: the duplicate outcome is still an ack', async () => {
    paymentEvents.process.mockResolvedValueOnce('processed').mockResolvedValueOnce('duplicate')

    await expect(controller.handle(requestWith(Buffer.from('{}')), 'sig')).resolves.toEqual({
      received: true,
    })
    await expect(controller.handle(requestWith(Buffer.from('{}')), 'sig')).resolves.toEqual({
      received: true,
    })
  })
})
