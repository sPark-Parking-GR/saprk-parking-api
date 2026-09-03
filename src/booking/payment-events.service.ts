import { Injectable, Logger } from '@nestjs/common'
import { BookingStatus, PaymentStatus, Prisma, RefundStatus } from '@prisma/client'
import type { PaymentWebhookEvent } from '@spark/types'
import { isWebhookReplayTarget, type WebhookSurface } from '../common/webhook-surface'
import { NotificationsService } from '../notifications/notifications.service'
import { PaymentsService } from '../payments/payments.service'
import { PrismaService } from '../prisma/prisma.service'
import type { BookingNotificationData } from '../notifications/notification.types'
import { generateQrSecret } from './credentials'

export type PaymentEventOutcome =
  | 'processed'
  | 'duplicate'
  | 'unknown_type'
  | 'unmatched_payment'
  | 'already_applied'
  | 'stale'
  | 'needs_reconciliation'

type EventKind =
  | 'payment_succeeded'
  | 'payment_failed'
  | 'refund_settled'
  | 'refund_failed'
  | 'unknown'

interface HandlerResult {
  outcome: Exclude<PaymentEventOutcome, 'duplicate'>
  notification?: { kind: 'confirmation' | 'cancellation'; data: BookingNotificationData }
}

const paymentInclude = {
  booking: {
    select: {
      id: true,
      status: true,
      expiresAt: true,
      accessCode: true,
      startsAt: true,
      endsAt: true,
      quotedPriceCents: true,
      currency: true,
      userId: true,
      facility: { select: { name: true } },
      user: { select: { email: true } },
    },
  },
  refund: { select: { id: true, status: true, providerRefundId: true } },
} satisfies Prisma.PaymentInclude

type PaymentWithBooking = Prisma.PaymentGetPayload<{ include: typeof paymentInclude }>

/**
 * This handler's half of the WebhookEvent replay gate. Booking payments have never collided
 * with the subscription handlers — they consume a disjoint set of provider event types — but
 * the ledger's unique key is compound for all three writers, so the surface has to be named
 * on every insert or the gate silently stops matching.
 */
const SURFACE: WebhookSurface = 'payments'

/**
 * Applies provider webhook events to payment/booking state. The webhook, not the
 * client, is the authoritative source of payment state: a client that pays and
 * drops the connection still gets its booking confirmed here.
 */
@Injectable()
export class PaymentEventsService {
  private readonly logger = new Logger(PaymentEventsService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
    private readonly notifications: NotificationsService,
  ) {}

  async process(event: PaymentWebhookEvent): Promise<PaymentEventOutcome> {
    let result: HandlerResult
    try {
      result = await this.prisma.$transaction(async (tx) => {
        // Insert-first: the unique (providerEventId, surface) is the replay gate. A
        // redelivery fails here with P2002 before any state is touched; a handler failure
        // rolls this insert back with it, so the provider's retry gets a clean attempt.
        await tx.webhookEvent.create({
          data: {
            providerEventId: event.id,
            surface: SURFACE,
            provider: this.payments.providerName,
            type: event.type,
            payload: event.raw == null ? Prisma.JsonNull : (event.raw as Prisma.InputJsonValue),
          },
        })

        const handled = await this.dispatch(event, tx)

        await tx.webhookEvent.update({
          where: { providerEventId_surface: { providerEventId: event.id, surface: SURFACE } },
          data: { outcome: handled.outcome, processedAt: new Date() },
        })

        return handled
      })
    } catch (error) {
      // Only the replay gate itself. The same transaction writes Payment, Booking and Refund,
      // any of whose uniques could raise a P2002 of their own — acknowledging one of those as
      // a duplicate would 200 a genuine failure the provider would then never retry.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' &&
        isWebhookReplayTarget((error.meta as { target?: unknown } | undefined)?.target)
      ) {
        this.logger.log(`Webhook event ${event.id} already processed, acknowledging replay`)
        return 'duplicate'
      }
      throw error
    }

    if (result.notification) {
      // After commit, and never fatal: a redelivery is swallowed by the dedup gate,
      // so failing the response over a notification could not trigger a resend anyway.
      try {
        if (result.notification.kind === 'confirmation') {
          await this.notifications.sendBookingConfirmation(result.notification.data)
          await this.notifications.sendBookingConfirmationPush(result.notification.data)
        } else {
          await this.notifications.sendBookingCancellation(result.notification.data)
        }
      } catch (error) {
        this.logger.error(
          `Notification for booking ${result.notification.data.bookingId} failed after webhook ${event.id}`,
          error instanceof Error ? error.stack : String(error),
        )
      }
    }

    return result.outcome
  }

  private async dispatch(
    event: PaymentWebhookEvent,
    tx: Prisma.TransactionClient,
  ): Promise<HandlerResult> {
    switch (this.classify(event)) {
      case 'payment_succeeded':
        return this.applyPaymentSucceeded(event, tx)
      case 'payment_failed':
        return this.applyPaymentFailed(event, tx)
      case 'refund_settled':
        return this.applyRefundSettled(event, tx)
      case 'refund_failed':
        return this.applyRefundFailed(event, tx)
      case 'unknown':
        // Acknowledged, not retried: a non-200 would make the provider redeliver an
        // event we will never understand. The ledger row is its audit trail.
        this.logger.warn(`Unhandled payment webhook type ${event.type} (event ${event.id})`)
        return { outcome: 'unknown_type' }
    }
  }

  // Classification leans on status first and type substrings second so a provider
  // adding statuses (e.g. an authorized-awaiting-capture value) degrades to
  // 'unknown' — recorded and acknowledged — instead of breaking dispatch.
  private classify(event: PaymentWebhookEvent): EventKind {
    const type = event.type.toLowerCase()
    if (type.includes('refund') || event.providerRefundId) {
      if (event.status === 'succeeded') return 'refund_settled'
      if (event.status === 'failed' || event.status === 'canceled') return 'refund_failed'
      return 'unknown'
    }
    if (event.status === 'succeeded' || type.endsWith('payment_intent.succeeded')) {
      return 'payment_succeeded'
    }
    if (event.status === 'failed' || type.endsWith('payment_failed')) {
      return 'payment_failed'
    }
    return 'unknown'
  }

  private async applyPaymentSucceeded(
    event: PaymentWebhookEvent,
    tx: Prisma.TransactionClient,
  ): Promise<HandlerResult> {
    const payment = await this.findPayment(event, tx)
    if (!payment) return { outcome: 'unmatched_payment' }

    if (payment.status !== PaymentStatus.PENDING && payment.status !== PaymentStatus.FAILED) {
      return { outcome: 'already_applied' }
    }

    const booking = payment.booking

    if (booking.status !== BookingStatus.PENDING_PAYMENT) {
      // Money moved but the booking already reached a final state (expired hold,
      // client cancel). Record the payment truthfully and flag for reconciliation —
      // never resurrect the booking, its slot may have been resold.
      await tx.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.SUCCEEDED },
      })
      await this.audit(tx, booking, 'payment.succeeded_after_final_state', event)
      this.logger.error(
        `Payment ${payment.providerPaymentId} succeeded but booking ${booking.id} is ${booking.status}; refund reconciliation required`,
      )
      return { outcome: 'needs_reconciliation' }
    }

    if (booking.expiresAt && booking.expiresAt < new Date()) {
      // Same rule as the client confirm path: past-expiry holds are not confirmed
      // because the overlap counter already treats them as released — confirming
      // could oversell the facility.
      await tx.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.SUCCEEDED },
      })
      await tx.booking.update({
        where: { id: booking.id },
        data: {
          status: BookingStatus.EXPIRED,
          statusHistory: { create: { status: BookingStatus.EXPIRED } },
        },
      })
      await this.audit(tx, booking, 'payment.succeeded_after_expiry', event)
      this.logger.error(
        `Payment ${payment.providerPaymentId} succeeded after hold expiry for booking ${booking.id}; refund reconciliation required`,
      )
      return { outcome: 'needs_reconciliation' }
    }

    await tx.payment.update({
      where: { id: payment.id },
      data: { status: PaymentStatus.SUCCEEDED },
    })
    await tx.booking.update({
      where: { id: booking.id },
      data: {
        status: BookingStatus.CONFIRMED,
        finalPriceCents: booking.quotedPriceCents,
        qrSecret: generateQrSecret(),
        expiresAt: null,
        statusHistory: { create: { status: BookingStatus.CONFIRMED } },
      },
    })
    await this.audit(tx, booking, 'booking.confirmed', event)

    return {
      outcome: 'processed',
      notification: { kind: 'confirmation', data: this.notificationData(payment) },
    }
  }

  private async applyPaymentFailed(
    event: PaymentWebhookEvent,
    tx: Prisma.TransactionClient,
  ): Promise<HandlerResult> {
    const payment = await this.findPayment(event, tx)
    if (!payment) return { outcome: 'unmatched_payment' }

    if (payment.status === PaymentStatus.FAILED) return { outcome: 'already_applied' }

    // Out-of-order guard: a failure notification arriving after the payment
    // succeeded is stale and must not unwind a confirmed booking.
    if (payment.status !== PaymentStatus.PENDING) {
      this.logger.warn(
        `Stale payment_failed event ${event.id} for payment ${payment.providerPaymentId} in status ${payment.status}`,
      )
      return { outcome: 'stale' }
    }

    const booking = payment.booking

    await tx.payment.update({ where: { id: payment.id }, data: { status: PaymentStatus.FAILED } })

    if (booking.status === BookingStatus.PENDING_PAYMENT) {
      await tx.booking.update({
        where: { id: booking.id },
        data: {
          status: BookingStatus.CANCELLED,
          statusHistory: { create: { status: BookingStatus.CANCELLED, note: 'payment failed' } },
        },
      })
    }
    await this.audit(tx, booking, 'booking.payment_failed', event)

    return { outcome: 'processed' }
  }

  private async applyRefundSettled(
    event: PaymentWebhookEvent,
    tx: Prisma.TransactionClient,
  ): Promise<HandlerResult> {
    const payment = await this.findPayment(event, tx)
    if (!payment) return { outcome: 'unmatched_payment' }

    if (!payment.refund) {
      // A refund we never requested (provider dashboard, dispute). Record the money
      // truthfully on the payment; the booking is left for a human decision.
      await tx.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.REFUNDED },
      })
      await this.audit(tx, payment.booking, 'payment.refunded_externally', event)
      this.logger.error(
        `Refund ${event.providerRefundId ?? '(unknown)'} settled for payment ${payment.providerPaymentId} with no local refund record; reconciliation required`,
      )
      return { outcome: 'needs_reconciliation' }
    }

    if (payment.refund.status === RefundStatus.SUCCEEDED) return { outcome: 'already_applied' }

    // Also covers a refund we recorded FAILED because the provider call timed out
    // after actually going through: the settlement event is the ground truth.
    await tx.refund.update({
      where: { id: payment.refund.id },
      data: {
        status: RefundStatus.SUCCEEDED,
        providerRefundId: event.providerRefundId ?? payment.refund.providerRefundId,
      },
    })
    await tx.payment.update({
      where: { id: payment.id },
      data: { status: PaymentStatus.REFUNDED },
    })

    const booking = payment.booking
    if (
      booking.status === BookingStatus.REFUND_PENDING ||
      booking.status === BookingStatus.CONFIRMED
    ) {
      await tx.booking.update({
        where: { id: booking.id },
        data: {
          status: BookingStatus.REFUNDED,
          statusHistory: { create: { status: BookingStatus.REFUNDED } },
        },
      })
    }
    await this.audit(tx, booking, 'booking.refunded', event)

    return { outcome: 'processed' }
  }

  private async applyRefundFailed(
    event: PaymentWebhookEvent,
    tx: Prisma.TransactionClient,
  ): Promise<HandlerResult> {
    const payment = await this.findPayment(event, tx)
    if (!payment?.refund) return { outcome: payment ? 'stale' : 'unmatched_payment' }

    if (payment.refund.status !== RefundStatus.PENDING) return { outcome: 'already_applied' }

    // Booking stays REFUND_PENDING: that is the recoverable in-flight marker, and
    // cancelBooking resumes from it to retry the refund.
    await tx.refund.update({
      where: { id: payment.refund.id },
      data: { status: RefundStatus.FAILED },
    })
    await this.audit(tx, payment.booking, 'booking.refund_failed', event)
    this.logger.error(
      `Refund failed at provider for payment ${payment.providerPaymentId} (booking ${payment.booking.id}); retry required`,
    )

    return { outcome: 'processed' }
  }

  private async findPayment(
    event: PaymentWebhookEvent,
    tx: Prisma.TransactionClient,
  ): Promise<PaymentWithBooking | null> {
    if (!event.providerPaymentId) {
      this.logger.warn(`Webhook event ${event.id} (${event.type}) carries no providerPaymentId`)
      return null
    }
    const payment = await tx.payment.findUnique({
      where: { providerPaymentId: event.providerPaymentId },
      include: paymentInclude,
    })
    if (!payment) {
      this.logger.warn(
        `Webhook event ${event.id} references unknown payment ${event.providerPaymentId}`,
      )
    }
    return payment
  }

  private audit(
    tx: Prisma.TransactionClient,
    booking: { id: string },
    action: string,
    event: PaymentWebhookEvent,
  ) {
    return tx.auditLog.create({
      data: {
        action,
        entityType: 'Booking',
        entityId: booking.id,
        payload: { providerEventId: event.id, type: event.type },
      },
    })
  }

  private notificationData(payment: PaymentWithBooking): BookingNotificationData {
    const booking = payment.booking
    return {
      bookingId: booking.id,
      accessCode: booking.accessCode,
      facilityName: booking.facility.name,
      startsAt: booking.startsAt,
      endsAt: booking.endsAt,
      amountCents: booking.quotedPriceCents,
      currency: booking.currency,
      recipientEmail: booking.user.email,
      recipientUserId: booking.userId,
    }
  }
}
