import { Injectable, Logger } from '@nestjs/common'
import { BookingStatus, Prisma } from '@prisma/client'
import type { AuthUser } from '@spark/types'
import { OperatorScopeService } from '../common/authz/operator-scope.service'
import {
  MalformedTicketError,
  TicketNotFoundError,
  TicketNotIssuableError,
  TicketVerificationUnavailableError,
} from '../common/errors/domain.errors'
import { PrismaService } from '../prisma/prisma.service'
import { QrReplayCache } from './qr-replay.cache'
import {
  buildQrPayload,
  currentUnixMinute,
  parseQrPayload,
  payloadExpiresAt,
  signQrCode,
  signaturesMatch,
  withinSkewWindow,
  type QrPayloadParts,
} from './qr-ticket'
import type { VerifyTicketDto } from './dto/booking.dto'
import type {
  CheckInOutcome,
  IssuedTicket,
  TicketBookingSummary,
  TicketMethod,
  TicketVerdict,
  TicketVerification,
} from './ticket.types'

// qrSecret is selected because verification cannot happen without it and is stripped by
// toSummary before anything leaves the service. Nothing here is ever spread into a
// response — see BookingService.getBooking for the bare-include leak this avoids.
const SCAN_SELECT = {
  id: true,
  accessCode: true,
  status: true,
  startsAt: true,
  endsAt: true,
  vehiclePlate: true,
  vehicleType: true,
  qrSecret: true,
  facility: { select: { id: true, name: true } },
} satisfies Prisma.BookingSelect

type ScannedBooking = Prisma.BookingGetPayload<{ select: typeof SCAN_SELECT }>

const HONOURABLE: BookingStatus[] = [BookingStatus.CONFIRMED, BookingStatus.CHECKED_IN]

/**
 * Ticket verification at the barrier. The credential is a rotating HMAC over
 * (bookingId, unixMinute) keyed by the booking's own qrSecret, so a screenshot of the QR
 * is useless minutes later and useless twice.
 */
@Injectable()
export class TicketService {
  private readonly logger = new Logger(TicketService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly operatorScope: OperatorScopeService,
    private readonly replay: QrReplayCache,
  ) {}

  async verify(user: AuthUser, dto: VerifyTicketDto): Promise<TicketVerification> {
    return 'payload' in dto
      ? this.verifyQr(user, dto.payload, dto.autoCheckIn)
      : this.verifyAccessCode(user, dto.accessCode, dto.autoCheckIn)
  }

  private async verifyQr(
    user: AuthUser,
    payload: string,
    autoCheckIn: boolean,
  ): Promise<TicketVerification> {
    const parts = parseQrPayload(payload)
    if (!parts) throw new MalformedTicketError()

    const booking = await this.resolve(user, { id: parts.bookingId })
    return this.settle(user, booking, await this.qrVerdict(booking, parts), 'qr', autoCheckIn)
  }

  /**
   * The fallback for a dead phone. Authorisation is the identical operator-scoped lookup
   * the QR path runs, so another operator's booking is the same not-found. It consumes no
   * replay nonce, and that is not an omission: an access code is a long-lived identifier
   * printed on the customer's receipt and presented again at check-out, not a one-shot
   * value, so burning it on first use would break its second legitimate use. Single use is
   * enforced where it belongs for both paths — the compare-and-set in checkIn below.
   */
  private async verifyAccessCode(
    user: AuthUser,
    accessCode: string,
    autoCheckIn: boolean,
  ): Promise<TicketVerification> {
    const booking = await this.resolve(user, { accessCode })
    return this.settle(user, booking, this.statusVerdict(booking), 'access_code', autoCheckIn)
  }

  /**
   * The consumer's own rotating code. Issued server-side rather than by handing the phone
   * qrSecret: a secret on the device can be extracted once and then mints valid codes
   * forever, while a payload is stale within minutes. Owner only — staff have the scanner,
   * not the ticket.
   */
  async issue(user: AuthUser, bookingId: string): Promise<IssuedTicket> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { id: true, userId: true, status: true, qrSecret: true },
    })
    if (!booking || booking.userId !== user.id) throw new TicketNotFoundError()
    if (!booking.qrSecret || !HONOURABLE.includes(booking.status)) {
      throw new TicketNotIssuableError()
    }

    const unixMinute = currentUnixMinute()
    return {
      bookingId: booking.id,
      payload: buildQrPayload(booking.qrSecret, booking.id, unixMinute),
      unixMinute,
      expiresAt: payloadExpiresAt(unixMinute),
    }
  }

  private async resolve(user: AuthUser, match: Prisma.BookingWhereInput): Promise<ScannedBooking> {
    const scope = await this.operatorScope.resolve(user)

    const booking = await this.prisma.booking.findFirst({
      where: { ...match, facility: this.operatorScope.scopeWhere(scope) },
      select: SCAN_SELECT,
    })
    if (!booking) throw new TicketNotFoundError()

    return booking
  }

  // Authenticity, then freshness, then single-use — a forged signature must never be able
  // to burn the nonce a genuine code is about to need.
  private async qrVerdict(booking: ScannedBooking, parts: QrPayloadParts): Promise<TicketVerdict> {
    if (!booking.qrSecret) return 'not_honourable'

    const expected = signQrCode(booking.qrSecret, booking.id, parts.unixMinute)
    if (!signaturesMatch(parts.signature, expected)) return 'invalid_signature'
    if (!withinSkewWindow(parts.unixMinute, currentUnixMinute())) return 'outside_time_window'
    if ((await this.claimNonce(booking.id, parts.unixMinute)) === 'replayed') return 'already_used'

    return this.statusVerdict(booking)
  }

  /**
   * Redis down means a rotating code cannot be proven unused, and this refuses the scan
   * rather than waving it through. Failing open would re-open exactly the replay hole the
   * rotation exists to close, at the worst possible moment (an outage is when nobody is
   * watching the logs). It does not strand drivers either, because the access-code
   * fallback above touches no cache and stays live throughout — an operator who cannot
   * scan reads the code off the customer's booking and checks them in that way. 503 marks
   * it as the transient dependency failure it is.
   */
  private async claimNonce(bookingId: string, unixMinute: number) {
    try {
      return await this.replay.claim(bookingId, unixMinute)
    } catch (error) {
      this.logger.error(
        `QR replay cache unreachable verifying booking ${bookingId}`,
        error instanceof Error ? error.stack : String(error),
      )
      throw new TicketVerificationUnavailableError()
    }
  }

  private statusVerdict(booking: ScannedBooking): TicketVerdict {
    return HONOURABLE.includes(booking.status) ? 'valid' : 'not_honourable'
  }

  private async settle(
    user: AuthUser,
    booking: ScannedBooking,
    verdict: TicketVerdict,
    method: TicketMethod,
    autoCheckIn: boolean,
  ): Promise<TicketVerification> {
    const checkIn = verdict === 'valid' && autoCheckIn ? await this.checkIn(user, booking) : null
    const status =
      checkIn === 'performed' || checkIn === 'already_checked_in'
        ? BookingStatus.CHECKED_IN
        : booking.status

    return {
      verdict,
      valid: verdict === 'valid',
      method,
      checkIn,
      booking: this.toSummary(booking, status),
    }
  }

  /**
   * CONFIRMED → CHECKED_IN as a compare-and-set inside the scan's own transaction, so one
   * scan opens the barrier: no second round trip a driver could out-drive, and no window
   * where the ticket reads valid but the booking is not yet consumed. updateMany rather
   * than a read-then-update because the WHERE is re-evaluated against the locked row: two
   * gates scanning the same ticket at once queue on that lock and the loser matches zero
   * rows, so the history row and the audit entry are written exactly once.
   */
  private async checkIn(user: AuthUser, booking: ScannedBooking): Promise<CheckInOutcome> {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.booking.updateMany({
        where: { id: booking.id, status: BookingStatus.CONFIRMED },
        data: { status: BookingStatus.CHECKED_IN },
      })

      if (claimed.count === 0) {
        const fresh = await tx.booking.findUnique({
          where: { id: booking.id },
          select: { status: true },
        })
        return fresh?.status === BookingStatus.CHECKED_IN ? 'already_checked_in' : 'not_applicable'
      }

      await tx.bookingStatusHistory.create({
        data: {
          bookingId: booking.id,
          status: BookingStatus.CHECKED_IN,
          changedBy: user.id,
          note: 'ticket scan',
        },
      })
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          actorRole: user.role,
          action: 'booking.checked_in',
          entityType: 'Booking',
          entityId: booking.id,
        },
      })

      return 'performed'
    })
  }

  private toSummary(booking: ScannedBooking, status: BookingStatus): TicketBookingSummary {
    return {
      id: booking.id,
      accessCode: booking.accessCode,
      status,
      startsAt: booking.startsAt,
      endsAt: booking.endsAt,
      vehiclePlate: booking.vehiclePlate,
      vehicleType: booking.vehicleType,
      facility: booking.facility,
    }
  }
}
