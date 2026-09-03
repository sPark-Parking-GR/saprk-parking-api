import { BookingStatus, PaymentStatus, Prisma, RefundStatus } from '@prisma/client'
import type { PaymentIntentStatus, PaymentWebhookEvent } from '@spark/types'
import type { NotificationsService } from '../notifications/notifications.service'
import type { PaymentsService } from '../payments/payments.service'
import type { PrismaService } from '../prisma/prisma.service'
import { PaymentEventsService } from './payment-events.service'

/** The replay gate as PostgreSQL reports it: BOTH halves of the compound key. */
const duplicateError = () =>
  new Prisma.PrismaClientKnownRequestError('unique violation', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: ['providerEventId', 'surface'] },
  })

const succeededEvent: PaymentWebhookEvent = {
  id: 'evt_1',
  type: 'payment_intent.succeeded',
  providerPaymentId: 'pi_1',
  status: 'succeeded',
  raw: { id: 'evt_1' },
}

const failedEvent: PaymentWebhookEvent = {
  id: 'evt_2',
  type: 'payment_intent.payment_failed',
  providerPaymentId: 'pi_1',
  status: 'failed',
  raw: { id: 'evt_2' },
}

const refundSettledEvent: PaymentWebhookEvent = {
  id: 'evt_3',
  type: 'refund.updated',
  providerPaymentId: 'pi_1',
  providerRefundId: 're_1',
  status: 'succeeded',
  raw: { id: 'evt_3' },
}

const bookingRow = (status: BookingStatus) => ({
  id: 'b1',
  status,
  expiresAt: status === BookingStatus.PENDING_PAYMENT ? new Date(Date.now() + 60_000) : null,
  accessCode: 'CODE1234',
  startsAt: new Date('2026-08-01T10:00:00Z'),
  endsAt: new Date('2026-08-01T12:00:00Z'),
  quotedPriceCents: 500,
  currency: 'EUR',
  userId: 'u1',
  facility: { name: 'Lot A' },
  user: { email: 'owner@spark.gr' },
})

const paymentRow = (
  paymentStatus: PaymentStatus,
  bookingStatus: BookingStatus,
  refund: { id: string; status: RefundStatus; providerRefundId: string | null } | null = null,
) => ({
  id: 'p1',
  status: paymentStatus,
  providerPaymentId: 'pi_1',
  booking: bookingRow(bookingStatus),
  refund,
})

describe('PaymentEventsService', () => {
  let tx: {
    webhookEvent: { create: jest.Mock; update: jest.Mock }
    payment: { findUnique: jest.Mock; update: jest.Mock }
    booking: { update: jest.Mock }
    refund: { update: jest.Mock }
    auditLog: { create: jest.Mock }
  }
  let prisma: { $transaction: jest.Mock }
  let notifications: {
    sendBookingConfirmation: jest.Mock
    sendBookingConfirmationPush: jest.Mock
    sendBookingCancellation: jest.Mock
  }
  let service: PaymentEventsService

  beforeEach(() => {
    tx = {
      webhookEvent: { create: jest.fn(), update: jest.fn() },
      payment: { findUnique: jest.fn(), update: jest.fn() },
      booking: { update: jest.fn() },
      refund: { update: jest.fn() },
      auditLog: { create: jest.fn() },
    }
    prisma = { $transaction: jest.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)) }
    notifications = {
      sendBookingConfirmation: jest.fn(),
      sendBookingConfirmationPush: jest.fn(),
      sendBookingCancellation: jest.fn(),
    }
    service = new PaymentEventsService(
      prisma as unknown as PrismaService,
      { providerName: 'mock' } as unknown as PaymentsService,
      notifications as unknown as NotificationsService,
    )
  })

  it('processes the same event id once: the redelivery is acknowledged without touching state', async () => {
    tx.payment.findUnique.mockResolvedValue(
      paymentRow(PaymentStatus.PENDING, BookingStatus.PENDING_PAYMENT),
    )

    await expect(service.process(succeededEvent)).resolves.toBe('processed')

    tx.webhookEvent.create.mockRejectedValueOnce(duplicateError())
    await expect(service.process(succeededEvent)).resolves.toBe('duplicate')

    expect(tx.payment.findUnique).toHaveBeenCalledTimes(1)
    expect(tx.booking.update).toHaveBeenCalledTimes(1)
  })

  // The ledger is shared with the two subscription handlers, and the unique key that gates
  // replays is compound. Filing under the wrong surface — or omitting it — would stop the
  // gate matching and let every redelivery confirm a booking twice.
  it('files its ledger row under the payments surface', async () => {
    tx.payment.findUnique.mockResolvedValue(
      paymentRow(PaymentStatus.PENDING, BookingStatus.PENDING_PAYMENT),
    )

    await service.process(succeededEvent)

    expect(tx.webhookEvent.create.mock.calls[0]![0].data).toMatchObject({
      providerEventId: 'evt_1',
      surface: 'payments',
    })
    expect(tx.webhookEvent.update.mock.calls[0]![0].where).toEqual({
      providerEventId_surface: { providerEventId: 'evt_1', surface: 'payments' },
    })
  })

  /**
   * Only the replay gate is a replay. The same transaction writes Payment, Booking and
   * Refund, and answering 200 to one of THEIR uniqueness failures would file a genuine
   * unhandled error as a harmless duplicate the provider then never retries.
   */
  it('propagates a uniqueness failure that is not the replay gate', async () => {
    tx.payment.findUnique.mockResolvedValue(
      paymentRow(PaymentStatus.PENDING, BookingStatus.PENDING_PAYMENT),
    )
    tx.booking.update.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('unique violation', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['accessCode'] },
      }),
    )

    await expect(service.process(succeededEvent)).rejects.toBeInstanceOf(
      Prisma.PrismaClientKnownRequestError,
    )
  })

  it('acknowledges an unknown event type instead of failing into a retry loop', async () => {
    const event: PaymentWebhookEvent = {
      id: 'evt_x',
      type: 'customer.created',
      raw: {},
    }

    await expect(service.process(event)).resolves.toBe('unknown_type')

    expect(tx.webhookEvent.create).toHaveBeenCalledTimes(1)
    expect(tx.webhookEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ outcome: 'unknown_type' }) }),
    )
    expect(tx.payment.findUnique).not.toHaveBeenCalled()
  })

  it('degrades an unrecognised future status to unknown instead of misclassifying it', async () => {
    const event: PaymentWebhookEvent = {
      id: 'evt_y',
      type: 'payment_intent.amount_capturable_updated',
      providerPaymentId: 'pi_1',
      status: 'authorized' as PaymentIntentStatus,
      raw: {},
    }

    await expect(service.process(event)).resolves.toBe('unknown_type')
    expect(tx.payment.update).not.toHaveBeenCalled()
  })

  it('confirms a pending booking on payment success and notifies after commit', async () => {
    tx.payment.findUnique.mockResolvedValue(
      paymentRow(PaymentStatus.PENDING, BookingStatus.PENDING_PAYMENT),
    )

    await expect(service.process(succeededEvent)).resolves.toBe('processed')

    expect(tx.payment.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { status: PaymentStatus.SUCCEEDED },
    })
    const bookingUpdate = tx.booking.update.mock.calls[0]![0]
    expect(bookingUpdate.data.status).toBe(BookingStatus.CONFIRMED)
    expect(bookingUpdate.data.finalPriceCents).toBe(500)
    expect(bookingUpdate.data.qrSecret).toEqual(expect.any(String))
    // The webhook confirm path mints its own independent secret, exactly like the client
    // confirm path — never a hash of the access code the customer already holds.
    expect(bookingUpdate.data).not.toHaveProperty('qrTokenHash')
    expect(bookingUpdate.data.qrSecret).not.toBe('CODE1234')
    expect(notifications.sendBookingConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: 'b1', recipientEmail: 'owner@spark.gr' }),
    )
  })

  it('treats a success replay under a fresh event id as already applied', async () => {
    tx.payment.findUnique.mockResolvedValue(
      paymentRow(PaymentStatus.SUCCEEDED, BookingStatus.CONFIRMED),
    )

    await expect(service.process({ ...succeededEvent, id: 'evt_1b' })).resolves.toBe(
      'already_applied',
    )
    expect(tx.payment.update).not.toHaveBeenCalled()
    expect(tx.booking.update).not.toHaveBeenCalled()
  })

  it('a failed payment moves the booking out of PENDING_PAYMENT and releases the hold', async () => {
    tx.payment.findUnique.mockResolvedValue(
      paymentRow(PaymentStatus.PENDING, BookingStatus.PENDING_PAYMENT),
    )

    await expect(service.process(failedEvent)).resolves.toBe('processed')

    expect(tx.payment.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { status: PaymentStatus.FAILED },
    })
    expect(tx.booking.update.mock.calls[0]![0].data.status).toBe(BookingStatus.CANCELLED)
  })

  it('ignores a stale failure that arrives after the payment already succeeded', async () => {
    tx.payment.findUnique.mockResolvedValue(
      paymentRow(PaymentStatus.SUCCEEDED, BookingStatus.CONFIRMED),
    )

    await expect(service.process(failedEvent)).resolves.toBe('stale')
    expect(tx.payment.update).not.toHaveBeenCalled()
    expect(tx.booking.update).not.toHaveBeenCalled()
  })

  it('settles a pending refund: refund SUCCEEDED, payment REFUNDED, booking REFUNDED', async () => {
    tx.payment.findUnique.mockResolvedValue(
      paymentRow(PaymentStatus.SUCCEEDED, BookingStatus.REFUND_PENDING, {
        id: 'r1',
        status: RefundStatus.PENDING,
        providerRefundId: null,
      }),
    )

    await expect(service.process(refundSettledEvent)).resolves.toBe('processed')

    expect(tx.refund.update).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: { status: RefundStatus.SUCCEEDED, providerRefundId: 're_1' },
    })
    expect(tx.payment.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { status: PaymentStatus.REFUNDED },
    })
    expect(tx.booking.update.mock.calls[0]![0].data.status).toBe(BookingStatus.REFUNDED)
  })

  it('a settlement corrects a refund we recorded as FAILED after a provider timeout', async () => {
    tx.payment.findUnique.mockResolvedValue(
      paymentRow(PaymentStatus.SUCCEEDED, BookingStatus.REFUND_PENDING, {
        id: 'r1',
        status: RefundStatus.FAILED,
        providerRefundId: null,
      }),
    )

    await expect(service.process(refundSettledEvent)).resolves.toBe('processed')
    expect(tx.refund.update).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: { status: RefundStatus.SUCCEEDED, providerRefundId: 're_1' },
    })
  })

  it('acknowledges an event for a payment this system does not know', async () => {
    tx.payment.findUnique.mockResolvedValue(null)

    await expect(service.process(succeededEvent)).resolves.toBe('unmatched_payment')
    expect(tx.payment.update).not.toHaveBeenCalled()
  })

  it('flags a success landing on an already-final booking for reconciliation', async () => {
    tx.payment.findUnique.mockResolvedValue(
      paymentRow(PaymentStatus.PENDING, BookingStatus.CANCELLED),
    )

    await expect(service.process(succeededEvent)).resolves.toBe('needs_reconciliation')

    expect(tx.payment.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { status: PaymentStatus.SUCCEEDED },
    })
    expect(tx.booking.update).not.toHaveBeenCalled()
  })

  it('a notification failure never fails the webhook response', async () => {
    tx.payment.findUnique.mockResolvedValue(
      paymentRow(PaymentStatus.PENDING, BookingStatus.PENDING_PAYMENT),
    )
    notifications.sendBookingConfirmation.mockRejectedValue(new Error('smtp down'))

    await expect(service.process(succeededEvent)).resolves.toBe('processed')
  })
})
