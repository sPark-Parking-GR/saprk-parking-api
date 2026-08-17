import { Injectable, Logger } from '@nestjs/common'
import { BookingStatus, PaymentStatus, RefundStatus } from '@prisma/client'
import {
  AccessCodeGenerationError,
  BookingNotFoundError,
  BookingStatusTransitionError,
  IdempotencyConflictError,
  QuoteExpiredError,
  RefundFailedError,
} from '../common/errors/domain.errors'
import { isPlatformRole, type AuthUser } from '@spark/types'
import { Prisma } from '@prisma/client'
import { OperatorScopeService, type OperatorScope } from '../common/authz/operator-scope.service'
import { InventoryService } from '../inventory/inventory.service'
import { NotificationsService } from '../notifications/notifications.service'
import { PaymentsService } from '../payments/payments.service'
import { PrismaService } from '../prisma/prisma.service'
import { TariffService } from '../tariff/tariff.service'
import type { PriceQuote } from '../tariff/tariff.types'
import { generateAccessCode, generateQrSecret } from './credentials'
import type { ListBookingsDto, ListMyBookingsDto } from './dto/booking.dto'
import type {
  BookingDetail,
  BookingList,
  BookingResult,
  ConfirmedBooking,
  CreateBookingRequest,
  PinnedStay,
  RepricedStay,
} from './booking.types'

interface CancellableBooking {
  id: string
  status: BookingStatus
  currency: string
  payment: { id: string; providerPaymentId: string; amountCents: number }
}

const ACCESS_CODE_ATTEMPTS = 5

// One list projection for the ops board and the consumer's own trips: both render the same
// card, and a second hand-maintained select is how a column like qrSecret gets added back
// to exactly one of them.
const LIST_SELECT = {
  id: true,
  accessCode: true,
  status: true,
  startsAt: true,
  endsAt: true,
  vehiclePlate: true,
  vehicleType: true,
  quotedPriceCents: true,
  finalPriceCents: true,
  currency: true,
  createdAt: true,
  facility: { select: { id: true, name: true } },
} satisfies Prisma.BookingSelect

@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly tariff: TariffService,
    private readonly inventory: InventoryService,
    private readonly payments: PaymentsService,
    private readonly notifications: NotificationsService,
    private readonly operatorScope: OperatorScopeService,
  ) {}

  async adminList(user: AuthUser, query: ListBookingsDto): Promise<BookingList> {
    const scope = await this.operatorScope.resolve(user)
    const where = this.adminListWhere(scope, query)

    const [rows, total] = await Promise.all([
      this.prisma.booking.findMany({
        where,
        orderBy: { startsAt: 'desc' },
        skip: query.skip,
        take: query.take,
        select: LIST_SELECT,
      }),
      this.prisma.booking.count({ where }),
    ])

    return { items: rows, total, skip: query.skip, take: query.take }
  }

  /**
   * The authenticated consumer's own trips. Ownership is the whole `where` clause, not a
   * post-filter, so there is no id to probe and no operator scope involved. Ordered by
   * startsAt like the ops board: a trips list is read by when the stay is, not by when the
   * row happened to be written.
   */
  async listMine(user: AuthUser, query: ListMyBookingsDto): Promise<BookingList> {
    const where: Prisma.BookingWhereInput = { userId: user.id }
    if (query.status) where.status = query.status

    const [rows, total] = await Promise.all([
      this.prisma.booking.findMany({
        where,
        orderBy: { startsAt: 'desc' },
        skip: query.skip,
        take: query.take,
        select: LIST_SELECT,
      }),
      this.prisma.booking.count({ where }),
    ])

    return { items: rows, total, skip: query.skip, take: query.take }
  }

  private adminListWhere(scope: OperatorScope, query: ListBookingsDto): Prisma.BookingWhereInput {
    const facilityWhere: Prisma.FacilityWhereInput = { ...this.operatorScope.scopeWhere(scope) }
    if (scope.kind === 'platform' && query.facilityId) {
      facilityWhere.id = query.facilityId
    }

    const where: Prisma.BookingWhereInput = { facility: facilityWhere }
    if (scope.kind === 'operator' && query.facilityId) where.facilityId = query.facilityId
    if (query.status) where.status = query.status
    if (query.q) {
      where.OR = [
        { accessCode: { contains: query.q, mode: 'insensitive' } },
        { vehiclePlate: { contains: query.q, mode: 'insensitive' } },
      ]
    }
    return where
  }

  /**
   * Phase 1 of checkout. Holds inventory, creates an external payment intent,
   * and persists a PENDING payment row. Returns the client secret so the caller
   * can complete payment. Idempotent on `idempotencyKey`.
   */
  async createBooking(request: CreateBookingRequest): Promise<BookingResult> {
    const existing = await this.prisma.booking.findUnique({
      where: { idempotencyKey: request.idempotencyKey },
      select: {
        id: true,
        accessCode: true,
        status: true,
        expiresAt: true,
        quotedPriceCents: true,
        currency: true,
        payment: { select: { providerPaymentId: true } },
      },
    })

    if (existing) return this.replayBookingResult(existing)

    const quote = await this.tariff.computeQuote({
      facilityId: request.facilityId,
      startsAt: request.startsAt,
      endsAt: request.endsAt,
      vehicleType: request.vehicleType,
    })

    if (quote.expiresAt < new Date()) throw new QuoteExpiredError()

    const { bookingId, expiresAt, accessCode } = await this.holdWithAccessCode(request, quote)

    const intent = await this.payments.createPaymentIntent({
      amountCents: quote.totalCents,
      currency: quote.currency,
      idempotencyKey: `pi_${bookingId}`,
      description: `sPark booking ${accessCode}`,
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
      data: {
        actorId: request.userId,
        action: 'booking.created',
        entityType: 'Booking',
        entityId: bookingId,
      },
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
   * Holds the slot under a freshly minted access code, retrying on the (astronomically
   * unlikely) case that the code is already taken. The retry exists so a collision can
   * never surface as a raw P2002 on a column the client has no idea about; exhausting it
   * means the generator or the constraint is broken, which is a 503, not a bad request.
   */
  private async holdWithAccessCode(
    request: CreateBookingRequest,
    quote: PriceQuote,
  ): Promise<{ bookingId: string; expiresAt: Date; accessCode: string }> {
    for (let attempt = 1; attempt <= ACCESS_CODE_ATTEMPTS; attempt++) {
      const accessCode = generateAccessCode()
      try {
        const held = await this.inventory.holdSlot({
          facilityId: request.facilityId,
          startsAt: request.startsAt,
          endsAt: request.endsAt,
          quotedPriceCents: quote.totalCents,
          vehiclePlate: request.vehiclePlate,
          vehicleType: request.vehicleType,
          accessCode,
          tariffPlanId: quote.planId,
          tariffPlanVersion: quote.planVersion,
          idempotencyKey: request.idempotencyKey,
          userId: request.userId,
          vehicleId: request.vehicleId,
          sourceChannel: request.sourceChannel,
        })
        return { ...held, accessCode }
      } catch (error) {
        // Two concurrent requests with the same key both miss the findUnique above;
        // the loser lands on the unique index instead of a 500. The 409 tells the
        // client to replay the request, which then takes the replay branch.
        if (this.isUniqueViolationOn(error, 'idempotencyKey')) {
          throw new IdempotencyConflictError(request.idempotencyKey)
        }
        if (!this.isUniqueViolationOn(error, 'accessCode')) throw error
        this.logger.warn(`Access code collision on attempt ${attempt}, regenerating`)
      }
    }

    throw new AccessCodeGenerationError(ACCESS_CODE_ATTEMPTS)
  }

  /**
   * Idempotent replay of createBooking. The client secret is re-derived from the
   * provider rather than persisted: `pi_<bookingId>` is a stable idempotency key,
   * and the provider replays the cached original create response — Stripe retains
   * it, client_secret included, for 24h, far beyond the minutes-long booking hold —
   * so a credential-like value never has to live in our database.
   */
  private async replayBookingResult(existing: {
    id: string
    accessCode: string
    status: BookingStatus
    expiresAt: Date | null
    quotedPriceCents: number
    currency: string
    payment: { providerPaymentId: string | null } | null
  }): Promise<BookingResult> {
    const base: BookingResult = {
      bookingId: existing.id,
      accessCode: existing.accessCode,
      expiresAt: existing.expiresAt ?? new Date(),
      amountCents: existing.quotedPriceCents,
      currency: existing.currency,
      alreadyExisted: true,
    }

    if (existing.status !== BookingStatus.PENDING_PAYMENT) return base

    const intent = await this.payments.createPaymentIntent({
      amountCents: existing.quotedPriceCents,
      currency: existing.currency,
      idempotencyKey: `pi_${existing.id}`,
      description: `sPark booking ${existing.accessCode}`,
      metadata: { bookingId: existing.id },
    })

    // Never hand out a secret for an intent the booking is not recorded against —
    // a mismatch means the provider's idempotency window lapsed and minted a fresh
    // intent, which no local payment row tracks.
    if (
      existing.payment?.providerPaymentId &&
      existing.payment.providerPaymentId !== intent.providerPaymentId
    ) {
      this.logger.error(
        `Replay for booking ${existing.id} returned intent ${intent.providerPaymentId} but payment row holds ${existing.payment.providerPaymentId}`,
      )
      return base
    }

    // Heals the crash window between holdSlot and payment.create: without a payment
    // row the booking could never be confirmed, defeating the point of the replay.
    if (!existing.payment) {
      await this.prisma.payment.upsert({
        where: { bookingId: existing.id },
        create: {
          bookingId: existing.id,
          amountCents: existing.quotedPriceCents,
          currency: existing.currency,
          provider: this.payments.providerName,
          providerPaymentId: intent.providerPaymentId,
          status: PaymentStatus.PENDING,
          idempotencyKey: `pay_${existing.id}`,
        },
        update: {},
      })
    }

    return { ...base, clientSecret: intent.clientSecret }
  }

  private isUniqueViolationOn(error: unknown, field: string): boolean {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
      return false
    }
    const target = (error.meta as { target?: unknown } | undefined)?.target
    return Array.isArray(target) ? target.includes(field) : String(target ?? '').includes(field)
  }

  /**
   * Phase 2 of checkout. Captures the payment with the provider, then atomically
   * marks the payment SUCCEEDED and transitions the booking to CONFIRMED.
   * Idempotent: a booking already CONFIRMED returns its current state.
   */
  async confirmBooking(bookingId: string, user: AuthUser): Promise<ConfirmedBooking> {
    await this.assertBookingAccess(bookingId, user)
    return this.captureAndConfirm(bookingId)
  }

  private async captureAndConfirm(bookingId: string): Promise<ConfirmedBooking> {
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

    const qrSecret = generateQrSecret()

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
          qrSecret,
          expiresAt: null,
          statusHistory: { create: { status: BookingStatus.CONFIRMED } },
        },
      })

      await tx.auditLog.create({
        data: {
          actorId: booking.userId,
          action: 'booking.confirmed',
          entityType: 'Booking',
          entityId: booking.id,
          payload: { providerPaymentId: booking.payment!.providerPaymentId },
        },
      })
    })

    await this.notifications.sendBookingConfirmation({
      bookingId: booking.id,
      accessCode: booking.accessCode,
      facilityName: booking.facility.name,
      startsAt: booking.startsAt,
      endsAt: booking.endsAt,
      amountCents: booking.quotedPriceCents,
      currency: booking.currency,
      recipientEmail: booking.user.email,
    })

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

  /**
   * Cancels a booking. A paid booking is refunded in two phases: the refund intent
   * is recorded BEFORE the provider is called, and the outcome afterwards — never
   * the provider call first. A crash or provider failure between phases leaves
   * REFUND_PENDING plus a PENDING/FAILED Refund row: recoverable and visibly
   * in-flight, instead of returned money the system knows nothing about.
   */
  async cancelBooking(bookingId: string, user: AuthUser): Promise<void> {
    await this.assertBookingAccess(bookingId, user)

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
        facility: { select: { name: true } },
        user: { select: { email: true } },
        payment: { select: { id: true, providerPaymentId: true, amountCents: true, status: true } },
      },
    })

    if (!booking) throw new BookingNotFoundError(bookingId)

    // REFUND_PENDING is re-enterable by design: it is the crash/failure marker of a
    // previous cancel attempt, and retrying the cancel resumes the refund.
    const cancellable: BookingStatus[] = [
      BookingStatus.PENDING_PAYMENT,
      BookingStatus.CONFIRMED,
      BookingStatus.REFUND_PENDING,
    ]
    if (!cancellable.includes(booking.status)) {
      throw new BookingStatusTransitionError(booking.status, 'CANCELLED')
    }

    const needsRefund =
      booking.status === BookingStatus.REFUND_PENDING ||
      (booking.status === BookingStatus.CONFIRMED &&
        booking.payment?.status === PaymentStatus.SUCCEEDED &&
        !!booking.payment.providerPaymentId)

    if (needsRefund && booking.payment?.providerPaymentId) {
      await this.refundAndCancel(
        {
          id: booking.id,
          status: booking.status,
          currency: booking.currency,
          payment: {
            id: booking.payment.id,
            providerPaymentId: booking.payment.providerPaymentId,
            amountCents: booking.payment.amountCents,
          },
        },
        user,
      )
    } else {
      await this.prisma.$transaction(async (tx) => {
        await tx.booking.update({
          where: { id: booking.id },
          data: {
            status: BookingStatus.CANCELLED,
            statusHistory: { create: { status: BookingStatus.CANCELLED, changedBy: user.id } },
          },
        })
        await tx.auditLog.create({
          data: {
            actorId: user.id,
            action: 'booking.cancelled',
            entityType: 'Booking',
            entityId: booking.id,
          },
        })
      })
    }

    await this.notifications.sendBookingCancellation({
      bookingId: booking.id,
      accessCode: booking.accessCode,
      facilityName: booking.facility.name,
      startsAt: booking.startsAt,
      endsAt: booking.endsAt,
      amountCents: booking.quotedPriceCents,
      currency: booking.currency,
      recipientEmail: booking.user.email,
    })
  }

  private async refundAndCancel(booking: CancellableBooking, user: AuthUser): Promise<void> {
    // Phase 1 — durably mark intent before any money can move. If we crash right
    // after this transaction, the provider was not called yet and the booking shows
    // an in-flight refund; if we crash after the provider call, the same state tells
    // recovery exactly what to resume.
    if (booking.status === BookingStatus.CONFIRMED) {
      try {
        await this.prisma.$transaction(async (tx) => {
          const fresh = await tx.booking.findUnique({
            where: { id: booking.id },
            select: { status: true },
          })
          if (fresh?.status !== BookingStatus.CONFIRMED) {
            throw new BookingStatusTransitionError(fresh?.status ?? 'UNKNOWN', 'REFUND_PENDING')
          }
          await tx.booking.update({
            where: { id: booking.id },
            data: {
              status: BookingStatus.REFUND_PENDING,
              statusHistory: {
                create: { status: BookingStatus.REFUND_PENDING, changedBy: user.id },
              },
            },
          })
          await tx.refund.create({
            data: {
              bookingId: booking.id,
              paymentId: booking.payment.id,
              amountCents: booking.payment.amountCents,
              currency: booking.currency,
              reason: 'booking_cancelled',
              status: RefundStatus.PENDING,
            },
          })
          await tx.auditLog.create({
            data: {
              actorId: user.id,
              action: 'booking.refund_requested',
              entityType: 'Booking',
              entityId: booking.id,
            },
          })
        })
      } catch (error) {
        // A concurrent cancel won phase 1; its Refund row is ours to resume.
        if (!this.isUniqueViolationOn(error, 'bookingId')) throw error
      }
    }

    // Phase 2 — the provider call, OUTSIDE any transaction. `ref_<bookingId>` makes
    // it idempotent at the provider, so a resumed or concurrent cancel cannot
    // double-refund.
    let result: { providerRefundId: string; status: string }
    try {
      result = await this.payments.refund({
        providerPaymentId: booking.payment.providerPaymentId,
        amountCents: booking.payment.amountCents,
        idempotencyKey: `ref_${booking.id}`,
        reason: 'booking_cancelled',
      })
    } catch (error) {
      await this.recordRefundFailure(booking.id, user)
      this.logger.error(
        `Refund call failed for booking ${booking.id}`,
        error instanceof Error ? error.stack : String(error),
      )
      throw new RefundFailedError(booking.id)
    }

    if (result.status === 'failed') {
      await this.recordRefundFailure(booking.id, user)
      throw new RefundFailedError(booking.id)
    }

    // Phase 3 — record the outcome. Anything not terminal ('pending' or a status
    // this code predates) keeps the in-flight marker; the refund webhook settles it.
    await this.prisma.$transaction(async (tx) => {
      if (result.status !== 'succeeded') {
        await tx.refund.update({
          where: { bookingId: booking.id },
          data: { providerRefundId: result.providerRefundId },
        })
        return
      }

      await tx.refund.update({
        where: { bookingId: booking.id },
        data: { status: RefundStatus.SUCCEEDED, providerRefundId: result.providerRefundId },
      })
      await tx.payment.update({
        where: { id: booking.payment.id },
        data: { status: PaymentStatus.REFUNDED },
      })
      const fresh = await tx.booking.findUnique({
        where: { id: booking.id },
        select: { status: true },
      })
      if (fresh?.status === BookingStatus.REFUND_PENDING) {
        await tx.booking.update({
          where: { id: booking.id },
          data: {
            status: BookingStatus.REFUNDED,
            statusHistory: { create: { status: BookingStatus.REFUNDED, changedBy: user.id } },
          },
        })
      }
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          action: 'booking.refunded',
          entityType: 'Booking',
          entityId: booking.id,
        },
      })
    })
  }

  private async recordRefundFailure(bookingId: string, user: AuthUser): Promise<void> {
    // The booking deliberately stays REFUND_PENDING: paired with the FAILED Refund
    // row it is the retryable, human-visible record that money may still be owed.
    // If the provider actually processed the refund despite the failure we saw, the
    // settlement webhook flips this FAILED row to SUCCEEDED.
    await this.prisma.$transaction(async (tx) => {
      await tx.refund.update({
        where: { bookingId },
        data: { status: RefundStatus.FAILED },
      })
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          action: 'booking.refund_failed',
          entityType: 'Booking',
          entityId: bookingId,
        },
      })
    })
  }

  async checkIn(bookingId: string, user: AuthUser): Promise<void> {
    await this.transitionByOperator(
      bookingId,
      BookingStatus.CONFIRMED,
      BookingStatus.CHECKED_IN,
      user,
      'booking.checked_in',
    )
  }

  /**
   * Ends the stay and settles what it actually cost. Until now finalPriceCents was the
   * quote, so a driver who booked two hours and left after five was billed for two.
   *
   * What this MOVES: nothing. The original intent was captured at confirm, so collecting
   * an overstay needs a brand new payment intent, and refunding an early departure is a
   * cancellation-policy decision, not an obvious default — neither belongs at a barrier,
   * where a provider timeout would strand a driver behind a closed gate. What it RECORDS:
   * the corrected finalPriceCents, the signed delta in priceAdjustmentCents, a status
   * history note and an audit row. Settlement is an explicit follow-up over that ledger.
   */
  async checkOut(bookingId: string, user: AuthUser): Promise<void> {
    const scope = await this.operatorScope.resolve(user)

    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        status: true,
        startsAt: true,
        quotedPriceCents: true,
        currency: true,
        tariffPlanId: true,
        tariffPlanVersion: true,
        facility: { select: { operatorId: true } },
      },
    })
    if (!booking) throw new BookingNotFoundError(bookingId)
    // Same not-found masking as transitionByOperator: an operator must not be able to
    // probe for bookings outside their own facilities.
    if (
      scope.kind === 'operator' &&
      (booking.facility.operatorId === null ||
        !scope.operatorIds.includes(booking.facility.operatorId))
    ) {
      throw new BookingNotFoundError(bookingId)
    }
    if (booking.status !== BookingStatus.CHECKED_IN) {
      throw new BookingStatusTransitionError(booking.status, BookingStatus.CHECKED_OUT)
    }

    const priced = await this.repriceStay(booking, new Date())

    await this.prisma.$transaction(async (tx) => {
      const fresh = await tx.booking.findUnique({
        where: { id: bookingId },
        select: { status: true },
      })
      if (fresh?.status !== BookingStatus.CHECKED_IN) {
        throw new BookingStatusTransitionError(
          fresh?.status ?? 'UNKNOWN',
          BookingStatus.CHECKED_OUT,
        )
      }

      await tx.booking.update({
        where: { id: bookingId },
        data: {
          status: BookingStatus.CHECKED_OUT,
          finalPriceCents: priced.finalPriceCents,
          priceAdjustmentCents: priced.adjustmentCents,
          statusHistory: {
            create: {
              status: BookingStatus.CHECKED_OUT,
              changedBy: user.id,
              note: priced.note,
            },
          },
        },
      })

      await tx.auditLog.create({
        data: {
          actorId: user.id,
          action: 'booking.checked_out',
          entityType: 'Booking',
          entityId: bookingId,
          payload: {
            outcome: priced.outcome,
            quotedPriceCents: booking.quotedPriceCents,
            finalPriceCents: priced.finalPriceCents,
            adjustmentCents: priced.adjustmentCents,
          },
        },
      })
    })
  }

  /**
   * Reprices the real stay (booked start → actual check-out instant) against the plan
   * version the quote pinned. Every path that cannot produce a trustworthy number keeps
   * the quoted price and says why in the outcome: a barrier must still open, and guessing
   * a price the customer never agreed to is worse than billing the agreed one.
   */
  private async repriceStay(booking: PinnedStay, checkedOutAt: Date): Promise<RepricedStay> {
    const keepQuoted = (outcome: RepricedStay['outcome']): RepricedStay => ({
      finalPriceCents: booking.quotedPriceCents,
      adjustmentCents: null,
      outcome,
      note: `checked out, price unchanged (${outcome})`,
    })

    if (!booking.tariffPlanId || booking.tariffPlanVersion === null) {
      return keepQuoted('not_pinned')
    }
    // Checking out at or before the booked start leaves nothing billable to measure; the
    // pricing engine rejects a non-positive span outright.
    if (checkedOutAt <= booking.startsAt) return keepQuoted('no_billable_stay')

    let priced
    try {
      priced = await this.tariff.priceWithPinnedPlan({
        planId: booking.tariffPlanId,
        planVersion: booking.tariffPlanVersion,
        startsAt: booking.startsAt,
        endsAt: checkedOutAt,
      })
    } catch (error) {
      // Includes the pricing engine's 366-day ceiling: a stay left open that long is a
      // reconciliation case for a human, not a reason to trap the vehicle.
      this.logger.error(
        `Repricing booking ${booking.id} at check-out failed`,
        error instanceof Error ? error.stack : String(error),
      )
      return keepQuoted('reprice_failed')
    }

    if (!priced) return keepQuoted('plan_version_changed')
    if (priced.currency !== booking.currency) {
      this.logger.error(
        `Pinned plan ${booking.tariffPlanId} priced booking ${booking.id} in ${priced.currency} but the booking is in ${booking.currency}`,
      )
      return keepQuoted('currency_mismatch')
    }

    const adjustmentCents = priced.totalCents - booking.quotedPriceCents
    return {
      finalPriceCents: priced.totalCents,
      adjustmentCents,
      outcome: 'repriced',
      note: `checked out, repriced ${adjustmentCents >= 0 ? '+' : ''}${adjustmentCents} cents`,
    }
  }

  /**
   * Every field here is deliberate, not whatever `include` happens to expose: qrSecret
   * (the live QR credential) is never selected, and Payment/Refund omit provider-side
   * identifiers no caller needs. accessCode stays — it is the customer's own ticket, not
   * a secret. One shape for both the owning consumer and scoped staff: assertBookingAccess
   * already restricts callers to those two, and staff legitimately need the same customer
   * identity and payment/refund state to support the booking.
   */
  async getBooking(bookingId: string, user: AuthUser): Promise<BookingDetail> {
    await this.assertBookingAccess(bookingId, user)

    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        accessCode: true,
        status: true,
        startsAt: true,
        endsAt: true,
        vehiclePlate: true,
        vehicleType: true,
        quotedPriceCents: true,
        finalPriceCents: true,
        priceAdjustmentCents: true,
        currency: true,
        createdAt: true,
        facility: { select: { id: true, name: true, address: true } },
        user: { select: { email: true, displayName: true } },
        payment: {
          select: {
            status: true,
            amountCents: true,
            currency: true,
            provider: true,
            createdAt: true,
          },
        },
        refund: {
          select: { status: true, amountCents: true, reason: true, createdAt: true },
        },
        statusHistory: {
          orderBy: { changedAt: 'asc' },
          select: { id: true, status: true, note: true, changedBy: true, changedAt: true },
        },
      },
    })
    if (!booking) throw new BookingNotFoundError(bookingId)
    return booking
  }

  /**
   * The one ownership predicate for consumer-facing booking access: the booking's own
   * user, or operator/platform staff scoped to the facility holding it.
   */
  private async assertBookingAccess(bookingId: string, user: AuthUser): Promise<void> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { userId: true, facility: { select: { operatorId: true } } },
    })
    if (!booking) throw new BookingNotFoundError(bookingId)
    if (booking.userId === user.id) return

    // Scope is resolved only for staff roles: OperatorScopeService answers a consumer with
    // a 403, and that distinct status is itself the existence leak this method prevents.
    if (this.isStaff(user)) {
      const scope = await this.operatorScope.resolve(user)
      if (
        scope.kind === 'platform' ||
        (booking.facility.operatorId !== null &&
          scope.operatorIds.includes(booking.facility.operatorId))
      ) {
        return
      }
    }

    // Someone else's booking is reported exactly like a nonexistent one, so an id cannot
    // be probed for existence — the same rule transitionByOperator applies to operators.
    throw new BookingNotFoundError(bookingId)
  }

  private isStaff(user: AuthUser): boolean {
    return user.role === 'operator_staff' || user.role === 'operator_admin' || isPlatformRole(user.role)
  }

  private async transitionByOperator(
    bookingId: string,
    from: BookingStatus,
    to: BookingStatus,
    user: AuthUser,
    action: string,
  ): Promise<void> {
    const scope = await this.operatorScope.resolve(user)

    await this.prisma.$transaction(async (tx) => {
      const booking = await tx.booking.findUnique({
        where: { id: bookingId },
        select: { status: true, facility: { select: { operatorId: true } } },
      })
      if (!booking) throw new BookingNotFoundError(bookingId)
      // Cross-operator access is reported as not-found so an operator cannot probe
      // for bookings outside their own facilities.
      if (
        scope.kind === 'operator' &&
        (booking.facility.operatorId === null ||
          !scope.operatorIds.includes(booking.facility.operatorId))
      ) {
        throw new BookingNotFoundError(bookingId)
      }
      if (booking.status !== from) {
        throw new BookingStatusTransitionError(booking.status, to)
      }

      await tx.booking.update({
        where: { id: bookingId },
        data: { status: to, statusHistory: { create: { status: to, changedBy: user.id } } },
      })

      await tx.auditLog.create({
        data: { actorId: user.id, action, entityType: 'Booking', entityId: bookingId },
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
}
