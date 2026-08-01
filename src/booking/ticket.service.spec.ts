import { BookingStatus, VehicleType } from '@prisma/client'
import type { AuthUser } from '@spark/types'
import type { OperatorScope, OperatorScopeService } from '../common/authz/operator-scope.service'
import {
  MalformedTicketError,
  TicketNotFoundError,
  TicketNotIssuableError,
  TicketVerificationUnavailableError,
} from '../common/errors/domain.errors'
import type { PrismaService } from '../prisma/prisma.service'
import type { QrReplayCache } from './qr-replay.cache'
import { buildQrPayload, currentUnixMinute, signQrCode } from './qr-ticket'
import { TicketService } from './ticket.service'

const QR_SECRET = 'ZmFrZS1xci1zZWNyZXQtZm9yLXRlc3RzLW9ubHktMDAwMDAw'
const BOOKING_ID = 'ckbooking000000000000001'
const ACCESS_CODE = '0123456789ABCDEFGHJKMNPQRS'

const staff: AuthUser = {
  id: 'u-staff',
  email: 'staff@spark.gr',
  role: 'operator_staff',
  emailVerified: true,
}

const consumer: AuthUser = {
  id: 'u-owner',
  email: 'owner@spark.gr',
  role: 'user',
  emailVerified: true,
}

function scannedBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOKING_ID,
    accessCode: ACCESS_CODE,
    status: BookingStatus.CONFIRMED,
    startsAt: new Date('2026-08-01T10:00:00.000Z'),
    endsAt: new Date('2026-08-01T12:00:00.000Z'),
    vehiclePlate: 'ABC1234',
    vehicleType: VehicleType.CAR,
    qrSecret: QR_SECRET,
    facility: { id: 'f1', name: 'Alpha garage' },
    ...overrides,
  }
}

describe('TicketService', () => {
  let prisma: {
    booking: { findFirst: jest.Mock; findUnique: jest.Mock; updateMany: jest.Mock }
    bookingStatusHistory: { create: jest.Mock }
    auditLog: { create: jest.Mock }
    $transaction: jest.Mock
  }
  let tx: {
    booking: { findUnique: jest.Mock; updateMany: jest.Mock }
    bookingStatusHistory: { create: jest.Mock }
    auditLog: { create: jest.Mock }
  }
  let scope: { resolve: jest.Mock; scopeWhere: jest.Mock }
  let replay: { claim: jest.Mock }
  let service: TicketService

  function setScope(resolved: OperatorScope) {
    scope.resolve.mockResolvedValue(resolved)
    scope.scopeWhere.mockReturnValue(
      resolved.kind === 'platform' ? {} : { operatorId: { in: resolved.operatorIds } },
    )
  }

  beforeEach(() => {
    tx = {
      booking: { findUnique: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      bookingStatusHistory: { create: jest.fn() },
      auditLog: { create: jest.fn() },
    }
    prisma = {
      booking: { findFirst: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn() },
      bookingStatusHistory: { create: jest.fn() },
      auditLog: { create: jest.fn() },
      $transaction: jest.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
    }
    scope = { resolve: jest.fn(), scopeWhere: jest.fn() }
    replay = { claim: jest.fn().mockResolvedValue('claimed') }
    service = new TicketService(
      prisma as unknown as PrismaService,
      scope as unknown as OperatorScopeService,
      replay as unknown as QrReplayCache,
    )
    setScope({ kind: 'operator', operatorIds: ['op1'] })
  })

  function livePayload(): string {
    return buildQrPayload(QR_SECRET, BOOKING_ID, currentUnixMinute())
  }

  describe('QR verification', () => {
    it('verifies a live code and never echoes qrSecret', async () => {
      prisma.booking.findFirst.mockResolvedValue(scannedBooking())

      const result = await service.verify(staff, { payload: livePayload(), autoCheckIn: false })

      expect(result.verdict).toBe('valid')
      expect(result.valid).toBe(true)
      expect(result.method).toBe('qr')
      expect(result.checkIn).toBeNull()
      expect(JSON.stringify(result)).not.toContain(QR_SECRET)
      expect(Object.keys(result.booking)).not.toContain('qrSecret')
    })

    it('rejects a tampered signature without consuming the replay nonce', async () => {
      prisma.booking.findFirst.mockResolvedValue(scannedBooking())
      const minute = currentUnixMinute()
      const signature = signQrCode(QR_SECRET, BOOKING_ID, minute)
      const forged = `v1.${BOOKING_ID}.${minute}.${signature.slice(0, -1)}${
        signature.endsWith('A') ? 'B' : 'A'
      }`

      const result = await service.verify(staff, { payload: forged, autoCheckIn: true })

      expect(result.verdict).toBe('invalid_signature')
      expect(result.valid).toBe(false)
      expect(replay.claim).not.toHaveBeenCalled()
      expect(prisma.$transaction).not.toHaveBeenCalled()
    })

    it('rejects a correctly signed code from outside the skew window', async () => {
      prisma.booking.findFirst.mockResolvedValue(scannedBooking())
      const stale = buildQrPayload(QR_SECRET, BOOKING_ID, currentUnixMinute() - 3)

      const result = await service.verify(staff, { payload: stale, autoCheckIn: true })

      expect(result.verdict).toBe('outside_time_window')
      expect(replay.claim).not.toHaveBeenCalled()
    })

    it('rejects a code whose (booking, minute) nonce was already spent', async () => {
      prisma.booking.findFirst.mockResolvedValue(scannedBooking())
      replay.claim.mockResolvedValue('replayed')

      const result = await service.verify(staff, { payload: livePayload(), autoCheckIn: true })

      expect(result.verdict).toBe('already_used')
      expect(prisma.$transaction).not.toHaveBeenCalled()
    })

    it('keys the nonce by booking and minute', async () => {
      prisma.booking.findFirst.mockResolvedValue(scannedBooking())
      const minute = currentUnixMinute()

      await service.verify(staff, {
        payload: buildQrPayload(QR_SECRET, BOOKING_ID, minute),
        autoCheckIn: false,
      })

      expect(replay.claim).toHaveBeenCalledWith(BOOKING_ID, minute)
    })

    it('refuses the scan when the replay cache cannot answer, rather than waving it through', async () => {
      prisma.booking.findFirst.mockResolvedValue(scannedBooking())
      replay.claim.mockRejectedValue(new Error('ECONNREFUSED'))

      await expect(
        service.verify(staff, { payload: livePayload(), autoCheckIn: true }),
      ).rejects.toBeInstanceOf(TicketVerificationUnavailableError)
      expect(prisma.$transaction).not.toHaveBeenCalled()
    })

    it('reports a booking outside the caller operator scope as not found', async () => {
      prisma.booking.findFirst.mockResolvedValue(null)

      await expect(
        service.verify(staff, { payload: livePayload(), autoCheckIn: false }),
      ).rejects.toBeInstanceOf(TicketNotFoundError)

      expect(prisma.booking.findFirst.mock.calls[0]![0].where.facility).toEqual({
        operatorId: { in: ['op1'] },
      })
    })

    it('rejects an unreadable payload before touching the database', async () => {
      await expect(
        service.verify(staff, { payload: 'not-a-ticket', autoCheckIn: false }),
      ).rejects.toBeInstanceOf(MalformedTicketError)
      expect(prisma.booking.findFirst).not.toHaveBeenCalled()
    })

    it('will not honour a booking that never reached CONFIRMED', async () => {
      prisma.booking.findFirst.mockResolvedValue(
        scannedBooking({ status: BookingStatus.CANCELLED }),
      )

      const result = await service.verify(staff, { payload: livePayload(), autoCheckIn: true })

      expect(result.verdict).toBe('not_honourable')
      expect(prisma.$transaction).not.toHaveBeenCalled()
    })

    it('will not honour a confirmed booking with no minted secret', async () => {
      prisma.booking.findFirst.mockResolvedValue(scannedBooking({ qrSecret: null }))

      const result = await service.verify(staff, { payload: livePayload(), autoCheckIn: false })

      expect(result.verdict).toBe('not_honourable')
    })
  })

  describe('autoCheckIn', () => {
    it('performs the transition, the history row and the audit entry exactly once', async () => {
      prisma.booking.findFirst.mockResolvedValue(scannedBooking())

      const result = await service.verify(staff, { payload: livePayload(), autoCheckIn: true })

      expect(result.checkIn).toBe('performed')
      expect(result.booking.status).toBe(BookingStatus.CHECKED_IN)
      expect(tx.booking.updateMany).toHaveBeenCalledTimes(1)
      expect(tx.booking.updateMany.mock.calls[0]![0].where).toEqual({
        id: BOOKING_ID,
        status: BookingStatus.CONFIRMED,
      })
      expect(tx.bookingStatusHistory.create).toHaveBeenCalledTimes(1)
      expect(tx.auditLog.create).toHaveBeenCalledTimes(1)
    })

    it('writes nothing extra when the compare-and-set loses to a concurrent scan', async () => {
      prisma.booking.findFirst.mockResolvedValue(scannedBooking())
      tx.booking.updateMany.mockResolvedValue({ count: 0 })
      tx.booking.findUnique.mockResolvedValue({ status: BookingStatus.CHECKED_IN })

      const result = await service.verify(staff, { payload: livePayload(), autoCheckIn: true })

      expect(result.verdict).toBe('valid')
      expect(result.checkIn).toBe('already_checked_in')
      expect(result.booking.status).toBe(BookingStatus.CHECKED_IN)
      expect(tx.bookingStatusHistory.create).not.toHaveBeenCalled()
      expect(tx.auditLog.create).not.toHaveBeenCalled()
    })

    it('reports a booking already scanned in as already_checked_in on a fresh code', async () => {
      prisma.booking.findFirst.mockResolvedValue(
        scannedBooking({ status: BookingStatus.CHECKED_IN }),
      )
      tx.booking.updateMany.mockResolvedValue({ count: 0 })
      tx.booking.findUnique.mockResolvedValue({ status: BookingStatus.CHECKED_IN })

      const result = await service.verify(staff, { payload: livePayload(), autoCheckIn: true })

      expect(result.verdict).toBe('valid')
      expect(result.checkIn).toBe('already_checked_in')
      expect(tx.bookingStatusHistory.create).not.toHaveBeenCalled()
    })

    it('does not transition when the caller did not ask for it', async () => {
      prisma.booking.findFirst.mockResolvedValue(scannedBooking())

      const result = await service.verify(staff, { payload: livePayload(), autoCheckIn: false })

      expect(result.checkIn).toBeNull()
      expect(prisma.$transaction).not.toHaveBeenCalled()
    })
  })

  describe('access code fallback', () => {
    it('authorises through the same operator-scoped lookup', async () => {
      prisma.booking.findFirst.mockResolvedValue(scannedBooking())

      const result = await service.verify(staff, { accessCode: ACCESS_CODE, autoCheckIn: false })

      expect(result.verdict).toBe('valid')
      expect(result.method).toBe('access_code')
      expect(prisma.booking.findFirst.mock.calls[0]![0].where).toEqual({
        accessCode: ACCESS_CODE,
        facility: { operatorId: { in: ['op1'] } },
      })
    })

    it('reports another operator booking as not found, exactly like the QR path', async () => {
      prisma.booking.findFirst.mockResolvedValue(null)

      await expect(
        service.verify(staff, { accessCode: ACCESS_CODE, autoCheckIn: false }),
      ).rejects.toBeInstanceOf(TicketNotFoundError)
    })

    it('keeps working with no replay cache, which is what makes failing closed safe', async () => {
      prisma.booking.findFirst.mockResolvedValue(scannedBooking())
      replay.claim.mockRejectedValue(new Error('ECONNREFUSED'))

      const result = await service.verify(staff, { accessCode: ACCESS_CODE, autoCheckIn: true })

      expect(result.verdict).toBe('valid')
      expect(result.checkIn).toBe('performed')
      expect(replay.claim).not.toHaveBeenCalled()
    })

    it('cannot check the same booking in twice', async () => {
      prisma.booking.findFirst.mockResolvedValue(scannedBooking())
      tx.booking.updateMany.mockResolvedValue({ count: 0 })
      tx.booking.findUnique.mockResolvedValue({ status: BookingStatus.CHECKED_IN })

      const result = await service.verify(staff, { accessCode: ACCESS_CODE, autoCheckIn: true })

      expect(result.checkIn).toBe('already_checked_in')
      expect(tx.bookingStatusHistory.create).not.toHaveBeenCalled()
    })
  })

  describe('issuing the consumer code', () => {
    it('returns a payload the verifier accepts, and no secret', async () => {
      prisma.booking.findUnique.mockResolvedValue({
        id: BOOKING_ID,
        userId: consumer.id,
        status: BookingStatus.CONFIRMED,
        qrSecret: QR_SECRET,
      })

      const issued = await service.issue(consumer, BOOKING_ID)

      expect(issued.payload).toBe(buildQrPayload(QR_SECRET, BOOKING_ID, issued.unixMinute))
      expect(JSON.stringify(issued)).not.toContain(QR_SECRET)
      expect(issued.expiresAt.getTime()).toBeGreaterThan(Date.now())
    })

    it('refuses to issue for somebody else booking', async () => {
      prisma.booking.findUnique.mockResolvedValue({
        id: BOOKING_ID,
        userId: 'u-other',
        status: BookingStatus.CONFIRMED,
        qrSecret: QR_SECRET,
      })

      await expect(service.issue(consumer, BOOKING_ID)).rejects.toBeInstanceOf(TicketNotFoundError)
    })

    it('refuses to issue for a booking with no live ticket', async () => {
      prisma.booking.findUnique.mockResolvedValue({
        id: BOOKING_ID,
        userId: consumer.id,
        status: BookingStatus.PENDING_PAYMENT,
        qrSecret: null,
      })

      await expect(service.issue(consumer, BOOKING_ID)).rejects.toBeInstanceOf(
        TicketNotIssuableError,
      )
    })
  })
})
