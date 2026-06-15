import { Injectable, Logger } from '@nestjs/common'
import { BookingStatus, PaymentStatus, RefundStatus } from '@prisma/client'
import { randomBytes, createHash } from 'crypto'
import {
  BookingNotFoundError,
  BookingStatusTransitionError,
  QuoteExpiredError,
} from '../common/errors/domain.errors'
import { InventoryService } from '../inventory/inventory.service'
import { NotificationsService } from '../notifications/notifications.service'
import { PaymentsService } from '../payments/payments.service'
import { PrismaService } from '../prisma/prisma.service'
import { TariffService } from '../tariff/tariff.service'
import type { BookingResult, ConfirmedBooking, CreateBookingRequest } from './booking.types'

@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly tariff: TariffService,
    private readonly inventory: InventoryService,
    private readonly payments: PaymentsService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Phase 1 of checkout. Holds inventory, creates an external payment intent,
   * and persists a PENDING payment row. Returns the client secret so the caller
   * can complete payment. Idempotent on `idempotencyKey`.
   */
  async createBooking(request: CreateBookingRequest): Promise<BookingResult> {
    const existing = await this.prisma.booking.findUnique({
      where: { idempotencyKey: request.idempotencyKey },
      select: { id: true, accessCode: true, expiresAt: true, quotedPriceCents: true, currency: true },
    })

    if (existing) {
      return {
        bookingId: existing.id,
        accessCode: existing.accessCode,
        expiresAt: existing.expiresAt ?? new Date(),
        amountCents: existing.quotedPriceCents,
        currency: existing.currency,
        alreadyExisted: true,
      }
    }

    const quote = await this.tariff.computeQuote({
      facilityId: request.facilityId,
      startsAt: request.startsAt,
      endsAt: request.endsAt,
      vehicleType: request.vehicleType,
    })

    if (quote.expiresAt < new Date()) throw new QuoteExpiredError()

    const accessCode = this.generateAccessCode()

    const { bookingId, expiresAt } = await this.inventory.holdSlot({
      facilityId: request.facilityId,
      startsAt: request.startsAt,
      endsAt: request.endsAt,
      quotedPriceCents: quote.totalCents,
      vehiclePlate: request.vehiclePlate,
      vehicleType: request.vehicleType,
      accessCode,
      idempotencyKey: request.idempotencyKey,
      userId: request.userId,
      vehicleId: request.vehicleId,
      guestEmail: request.guestEmail,
      guestPhone: request.guestPhone,
      sourceChannel: request.sourceChannel,
    })

    const intent = await this.payments.createPaymentIntent({
      amountCents: quote.totalCents,
      currency: quote.currency,
      idempotencyKey: `pi_${bookingId}`,
      description: `Parqin booking ${accessCode}`,
      metadata: { bookingId },
    })

    await this.prisma.payment.create({
      data: {
        bookingId,
        amountCents: quote.totalCents,
        currency: quote.currency,
        provider: this.payments.providerName,
        providerPaymentId: intent.providerPaymentId,
        status: PaymentStatus.PENDING,
        idempotencyKey: `pay_${bookingId}`,
      },
    })

    await this.prisma.auditLog.create({
      data: { actorId: request.userId, action: 'booking.created', entityType: 'Booking', entityId: bookingId },
    })

    return {
      bookingId,
      accessCode,
      expiresAt,
      amountCents: quote.totalCents,
      currency: quote.currency,
      clientSecret: intent.clientSecret,
      alreadyExisted: false,
    }
  }

  /**
   * Phase 2 of checkout. Captures the payment with the provider, then atomically
   * marks the payment SUCCEEDED and transitions the booking to CONFIRMED.
   * Idempotent: a booking already CONFIRMED returns its current state.
   */
  async confirmBooking(bookingId: string): Promise<ConfirmedBooking> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        status: true,
        expiresAt: true,
        accessCode: true,
        startsAt: true,
        endsAt: true,
        quotedPriceCents: true,
        finalPriceCents: true,
        currency: true,
        userId: true,
        guestEmail: true,
        facility: { select: { name: true } },
        user: { select: { email: true } },
        payment: { select: { id: true, providerPaymentId: true } },
      },
    })

    if (!booking) throw new BookingNotFoundError(bookingId)

    if (booking.status === BookingStatus.CONFIRMED) {
      return this.toConfirmed(booking)
    }

    if (booking.status !== BookingStatus.PENDING_PAYMENT) {
      throw new BookingStatusTransitionError(booking.status, 'CONFIRMED')
    }

    if (booking.expiresAt && booking.expiresAt < new Date()) {
      await this.prisma.booking.update({
        where: { id: booking.id },
        data: { status: BookingStatus.EXPIRED },
      })
      throw new QuoteExpiredError()
    }

    if (!booking.payment?.providerPaymentId) {
      throw new BookingStatusTransitionError(booking.status, 'CONFIRMED')
    }

    const captured = await this.payments.capturePayment({
      providerPaymentId: booking.payment.providerPaymentId,
      idempotencyKey: `cap_${booking.id}`,
    })

    if (captured.status !== 'succeeded') {
      await this.prisma.payment.update({
        where: { id: booking.payment.id },
        data: { status: PaymentStatus.FAILED },
      })
      throw new BookingStatusTransitionError(booking.status, 'CONFIRMED')
    }

    const qrTokenHash = this.hashQrToken(booking.accessCode)

    await this.prisma.$transaction(async (tx) => {
      const fresh = await tx.booking.findUnique({
        where: { id: booking.id },
        select: { status: true },
      })
      if (fresh?.status !== BookingStatus.PENDING_PAYMENT) {
        throw new BookingStatusTransitionError(fresh?.status ?? 'UNKNOWN', 'CONFIRMED')
      }

      await tx.payment.update({
        where: { id: booking.payment!.id },
        data: { status: PaymentStatus.SUCCEEDED },
      })

      await tx.booking.update({
        where: { id: booking.id },
        data: {
          status: BookingStatus.CONFIRMED,
          finalPriceCents: booking.quotedPriceCents,
          qrTokenHash,
          expiresAt: null,
          statusHistory: { create: { status: BookingStatus.CONFIRMED } },
        },
      })

      await tx.auditLog.create({
        data: {
          actorId: booking.userId ?? undefined,
          action: 'booking.confirmed',
          entityType: 'Booking',
          entityId: booking.id,
          payload: { providerPaymentId: booking.payment!.providerPaymentId },
        },
      })
    })

    const recipient = booking.guestEmail ?? booking.user?.email
    if (recipient) {
      await this.notifications.sendBookingConfirmation({
        bookingId: booking.id,
        accessCode: booking.accessCode,
        facilityName: booking.facility.name,
        startsAt: booking.startsAt,
        endsAt: booking.endsAt,
        amountCents: booking.quotedPriceCents,
        currency: booking.currency,
        recipientEmail: recipient,
      })
    }

    return {
      bookingId: booking.id,
      accessCode: booking.accessCode,
      status: 'CONFIRMED',
      startsAt: booking.startsAt,
      endsAt: booking.endsAt,
      finalPriceCents: booking.quotedPriceCents,
      currency: booking.currency,
    }
  }

  async confirmByProviderPaymentId(providerPaymentId: string): Promise<void> {
    const payment = await this.prisma.payment.findUnique({
      where: { providerPaymentId },
      select: { bookingId: true },
    })
    if (!payment) {
      this.logger.warn(`Webhook for unknown payment ${providerPaymentId}`)
      return
    }
    await this.confirmBooking(payment.bookingId)
  }

  /**
   * Cancels a booking. If it was CONFIRMED with a captured payment, issues a
   * refund with the provider and records it. DB writes are transactional; the
   * external refund call runs before the commit that records its result.
   */
  async cancelBooking(bookingId: string, actorId?: string): Promise<void> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        status: true,
        currency: true,
        accessCode: true,
        startsAt: true,
        endsAt: true,
        quotedPriceCents: true,
        guestEmail: true,
        facility: { select: { name: true } },
        user: { select: { email: true } },
        payment: { select: { id: true, providerPaymentId: true, amountCents: true, status: true } },
      },
    })

    if (!booking) throw new BookingNotFoundError(bookingId)

    const cancellable: BookingStatus[] = [BookingStatus.PENDING_PAYMENT, BookingStatus.CONFIRMED]
    if (!cancellable.includes(booking.status)) {
      throw new BookingStatusTransitionError(booking.status, 'CANCELLED')
    }

    const shouldRefund =
      booking.status === BookingStatus.CONFIRMED &&
      booking.payment?.status === PaymentStatus.SUCCEEDED &&
      !!booking.payment.providerPaymentId

    let refundResult: { providerRefundId: string } | null = null
    if (shouldRefund && booking.payment) {
      const result = await this.payments.refund({
        providerPaymentId: booking.payment.providerPaymentId!,
        amountCents: booking.payment.amountCents,
        idempotencyKey: `ref_${booking.id}`,
        reason: 'booking_cancelled',
      })
      refundResult = { providerRefundId: result.providerRefundId }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.booking.update({
        where: { id: booking.id },
        data: {
          status: refundResult ? BookingStatus.REFUNDED : BookingStatus.CANCELLED,
          statusHistory: {
            create: {
              status: refundResult ? BookingStatus.REFUNDED : BookingStatus.CANCELLED,
              changedBy: actorId,
            },
          },
        },
      })

      if (refundResult && booking.payment) {
        await tx.payment.update({
          where: { id: booking.payment.id },
          data: { status: PaymentStatus.REFUNDED },
        })
        await tx.refund.create({
          data: {
            bookingId: booking.id,
            paymentId: booking.payment.id,
            amountCents: booking.payment.amountCents,
            currency: booking.currency,
            reason: 'booking_cancelled',
            providerRefundId: refundResult.providerRefundId,
            status: RefundStatus.SUCCEEDED,
          },
        })
      }

      await tx.auditLog.create({
        data: {
          actorId,
          action: refundResult ? 'booking.refunded' : 'booking.cancelled',
          entityType: 'Booking',
          entityId: booking.id,
        },
      })
    })

    const recipient = booking.guestEmail ?? booking.user?.email
    if (recipient) {
      await this.notifications.sendBookingCancellation({
        bookingId: booking.id,
        accessCode: booking.accessCode,
        facilityName: booking.facility.name,
        startsAt: booking.startsAt,
        endsAt: booking.endsAt,
        amountCents: booking.quotedPriceCents,
        currency: booking.currency,
        recipientEmail: recipient,
      })
    }
  }

  async checkIn(bookingId: string, operatorId: string): Promise<void> {
    await this.transitionByOperator(
      bookingId,
      BookingStatus.CONFIRMED,
      BookingStatus.CHECKED_IN,
      operatorId,
      'booking.checked_in',
    )
  }

  async checkOut(bookingId: string, operatorId: string): Promise<void> {
    await this.transitionByOperator(
      bookingId,
      BookingStatus.CHECKED_IN,
      BookingStatus.CHECKED_OUT,
      operatorId,
      'booking.checked_out',
    )
  }

  async getBooking(bookingId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        facility: { select: { id: true, name: true, address: true } },
        statusHistory: { orderBy: { changedAt: 'asc' } },
      },
    })
    if (!booking) throw new BookingNotFoundError(bookingId)
    return booking
  }

  private async transitionByOperator(
    bookingId: string,
    from: BookingStatus,
    to: BookingStatus,
    operatorId: string,
    action: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const booking = await tx.booking.findUnique({
        where: { id: bookingId },
        select: { status: true },
      })
      if (!booking) throw new BookingNotFoundError(bookingId)
      if (booking.status !== from) {
        throw new BookingStatusTransitionError(booking.status, to)
      }

      await tx.booking.update({
        where: { id: bookingId },
        data: { status: to, statusHistory: { create: { status: to, changedBy: operatorId } } },
      })

      await tx.auditLog.create({
        data: { actorId: operatorId, action, entityType: 'Booking', entityId: bookingId },
      })
    })
  }

  private toConfirmed(booking: {
    id: string
    accessCode: string
    startsAt: Date
    endsAt: Date
    finalPriceCents: number | null
    quotedPriceCents: number
    currency: string
  }): ConfirmedBooking {
    return {
      bookingId: booking.id,
      accessCode: booking.accessCode,
      status: 'CONFIRMED',
      startsAt: booking.startsAt,
      endsAt: booking.endsAt,
      finalPriceCents: booking.finalPriceCents ?? booking.quotedPriceCents,
      currency: booking.currency,
    }
  }

  private generateAccessCode(): string {
    return randomBytes(4).toString('hex').toUpperCase()
  }

  private hashQrToken(accessCode: string): string {
    return createHash('sha256').update(accessCode).digest('hex')
  }
}
