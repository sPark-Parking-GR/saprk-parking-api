import { BookingStatus, UserRole, OperatorMemberRole } from '@prisma/client'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import request from 'supertest'
import type { PrismaService } from '../../src/prisma/prisma.service'
import { generateAccessCode, generateQrSecret } from '../../src/booking/credentials'
import { buildQrPayload, currentUnixMinute, signQrCode } from '../../src/booking/qr-ticket'
import { bearerToken } from '../utils/auth'
import { truncateAll } from '../utils/db'
import { seedBooking, seedFacility, seedOperator, seedUser } from '../utils/seed'
import { resetThrottle } from '../utils/throttle'
import { createTestApp } from '../utils/test-app'

const API = '/api/v1'
const STARTS_AT = new Date('2026-08-01T10:00:00.000Z')
const ENDS_AT = new Date('2026-08-01T12:00:00.000Z')

interface Tenant {
  facilityId: string
  bookingId: string
  qrSecret: string
  accessCode: string
  staffToken: string
  ownerToken: string
}

describe('QR ticket verification (e2e)', () => {
  let app: NestFastifyApplication
  let prisma: PrismaService
  let alpha: Tenant
  let beta: Tenant
  let outsiderToken: string

  beforeAll(async () => {
    const testApp = await createTestApp()
    app = testApp.app
    prisma = testApp.prisma
  })

  afterAll(async () => {
    await app.close()
  })

  async function seedTenant(name: string, lng: number): Promise<Tenant> {
    const operator = await seedOperator(prisma, { name })
    const facility = await seedFacility(prisma, {
      operatorId: operator.id,
      name: `${name} facility`,
      lat: 37.9838,
      lng,
    })
    const [staff, owner] = await Promise.all([
      seedUser(prisma, {
        role: UserRole.OPERATOR_STAFF,
        operatorId: operator.id,
        memberRole: OperatorMemberRole.STAFF,
      }),
      seedUser(prisma),
    ])

    const qrSecret = generateQrSecret()
    const accessCode = generateAccessCode()
    const booking = await seedBooking(prisma, {
      facilityId: facility.id,
      userId: owner.id,
      startsAt: STARTS_AT,
      endsAt: ENDS_AT,
      status: BookingStatus.CONFIRMED,
      qrSecret,
      accessCode,
    })

    return {
      facilityId: facility.id,
      bookingId: booking.id,
      qrSecret,
      accessCode,
      staffToken: bearerToken(staff),
      ownerToken: bearerToken(owner),
    }
  }

  beforeEach(async () => {
    await truncateAll(prisma)
    resetThrottle(app)
    ;[alpha, beta] = await Promise.all([seedTenant('Alpha', 23.7275), seedTenant('Beta', 23.7375)])
    const outsider = await seedUser(prisma, { role: UserRole.USER })
    outsiderToken = bearerToken(outsider)
  })

  function verify(body: Record<string, unknown>, token: string) {
    return request(app.getHttpServer())
      .post(`${API}/bookings/verify-qr`)
      .set('authorization', `Bearer ${token}`)
      .send(body)
  }

  function livePayload(tenant: Tenant, offsetMinutes = 0): string {
    return buildQrPayload(tenant.qrSecret, tenant.bookingId, currentUnixMinute() + offsetMinutes)
  }

  function checkInHistory(bookingId: string) {
    return prisma.bookingStatusHistory.count({
      where: { bookingId, status: BookingStatus.CHECKED_IN },
    })
  }

  describe('credential checks', () => {
    it('verifies a live code and reports an actionable summary', async () => {
      const response = await verify({ payload: livePayload(alpha) }, alpha.staffToken).expect(200)

      expect(response.body.verdict).toBe('valid')
      expect(response.body.valid).toBe(true)
      expect(response.body.method).toBe('qr')
      expect(response.body.checkIn).toBeNull()
      expect(response.body.booking).toMatchObject({
        id: alpha.bookingId,
        accessCode: alpha.accessCode,
        status: BookingStatus.CONFIRMED,
        facility: { id: alpha.facilityId },
      })
    })

    it('rejects a tampered signature', async () => {
      const minute = currentUnixMinute()
      const signature = signQrCode(alpha.qrSecret, alpha.bookingId, minute)
      const forged = `v1.${alpha.bookingId}.${minute}.${signature.slice(0, -1)}${
        signature.endsWith('A') ? 'B' : 'A'
      }`

      const response = await verify({ payload: forged }, alpha.staffToken).expect(200)

      expect(response.body.verdict).toBe('invalid_signature')
      expect(response.body.valid).toBe(false)
    })

    it('rejects a correctly signed code minted outside the skew window', async () => {
      const response = await verify({ payload: livePayload(alpha, -5) }, alpha.staffToken).expect(
        200,
      )

      expect(response.body.verdict).toBe('outside_time_window')
    })

    it('rejects a code signed with another booking secret', async () => {
      const crossSigned = buildQrPayload(beta.qrSecret, alpha.bookingId, currentUnixMinute())

      const response = await verify({ payload: crossSigned }, alpha.staffToken).expect(200)

      expect(response.body.verdict).toBe('invalid_signature')
    })

    it('rejects a string that is not a ticket at all', async () => {
      await verify({ payload: 'definitely-not-a-ticket' }, alpha.staffToken).expect(400)
    })
  })

  // The point of the whole scheme, and only provable against a real Redis.
  describe('replay', () => {
    it('refuses the second redemption of the same code', async () => {
      const payload = livePayload(alpha)

      const first = await verify({ payload }, alpha.staffToken).expect(200)
      const second = await verify({ payload }, alpha.staffToken).expect(200)

      expect(first.body.verdict).toBe('valid')
      expect(second.body.verdict).toBe('already_used')
      expect(second.body.valid).toBe(false)
    })

    it('spends the nonce per minute, so the next code from the same booking still works', async () => {
      await verify({ payload: livePayload(alpha) }, alpha.staffToken).expect(200)

      const next = await verify({ payload: livePayload(alpha, 1) }, alpha.staffToken).expect(200)

      expect(next.body.verdict).toBe('valid')
    })

    it('does not spend the nonce for a code that failed its signature check', async () => {
      const minute = currentUnixMinute()
      const signature = signQrCode(alpha.qrSecret, alpha.bookingId, minute)
      const forged = `v1.${alpha.bookingId}.${minute}.${signature.slice(0, -1)}${
        signature.endsWith('A') ? 'B' : 'A'
      }`

      await verify({ payload: forged }, alpha.staffToken).expect(200)
      const genuine = await verify(
        { payload: buildQrPayload(alpha.qrSecret, alpha.bookingId, minute) },
        alpha.staffToken,
      ).expect(200)

      expect(genuine.body.verdict).toBe('valid')
    })
  })

  describe('operator scope', () => {
    it('reports another operator booking as not found rather than forbidden', async () => {
      await verify({ payload: livePayload(beta) }, alpha.staffToken).expect(404)
    })

    it('reports another operator access code as not found too', async () => {
      await verify({ accessCode: beta.accessCode }, alpha.staffToken).expect(404)
    })

    it('closes the endpoint to consumers and to anonymous callers', async () => {
      await verify({ payload: livePayload(alpha) }, outsiderToken).expect(403)
      await request(app.getHttpServer())
        .post(`${API}/bookings/verify-qr`)
        .send({ payload: livePayload(alpha) })
        .expect(401)
    })
  })

  describe('autoCheckIn', () => {
    it('opens the barrier on one scan and transitions exactly once', async () => {
      const response = await verify(
        { payload: livePayload(alpha), autoCheckIn: true },
        alpha.staffToken,
      ).expect(200)

      expect(response.body.checkIn).toBe('performed')
      expect(response.body.booking.status).toBe(BookingStatus.CHECKED_IN)
      expect(await checkInHistory(alpha.bookingId)).toBe(1)
    })

    it('does not transition a second time when a fresh code is scanned again', async () => {
      await verify({ payload: livePayload(alpha), autoCheckIn: true }, alpha.staffToken).expect(200)

      const second = await verify(
        { payload: livePayload(alpha, 1), autoCheckIn: true },
        alpha.staffToken,
      ).expect(200)

      expect(second.body.verdict).toBe('valid')
      expect(second.body.checkIn).toBe('already_checked_in')
      expect(await checkInHistory(alpha.bookingId)).toBe(1)
    })

    // Distinct minutes so the replay cache lets all three through: what is under test here
    // is the database compare-and-set, not the nonce.
    it('lets exactly one of three simultaneous scans win', async () => {
      const minute = currentUnixMinute()
      const payloads = [minute - 1, minute, minute + 1].map((m) =>
        buildQrPayload(alpha.qrSecret, alpha.bookingId, m),
      )

      const responses = await Promise.all(
        payloads.map((payload) =>
          verify({ payload, autoCheckIn: true }, alpha.staffToken).expect(200),
        ),
      )

      const outcomes = responses.map((r) => r.body.checkIn as string)
      expect(outcomes.filter((outcome) => outcome === 'performed')).toHaveLength(1)
      expect(outcomes.filter((outcome) => outcome === 'already_checked_in')).toHaveLength(2)
      expect(await checkInHistory(alpha.bookingId)).toBe(1)
      expect(
        await prisma.auditLog.count({
          where: { entityId: alpha.bookingId, action: 'booking.checked_in' },
        }),
      ).toBe(1)
    })

    it('will not check in a booking that is not confirmed', async () => {
      await prisma.booking.update({
        where: { id: alpha.bookingId },
        data: { status: BookingStatus.CANCELLED },
      })

      const response = await verify(
        { payload: livePayload(alpha), autoCheckIn: true },
        alpha.staffToken,
      ).expect(200)

      expect(response.body.verdict).toBe('not_honourable')
      expect(response.body.checkIn).toBeNull()
      expect(await checkInHistory(alpha.bookingId)).toBe(0)
    })
  })

  describe('access code fallback', () => {
    it('verifies and checks in on the same authorisation as the QR path', async () => {
      const response = await verify(
        { accessCode: alpha.accessCode, autoCheckIn: true },
        alpha.staffToken,
      ).expect(200)

      expect(response.body.verdict).toBe('valid')
      expect(response.body.method).toBe('access_code')
      expect(response.body.checkIn).toBe('performed')
      expect(await checkInHistory(alpha.bookingId)).toBe(1)
    })

    it('cannot check the same booking in twice either', async () => {
      await verify({ accessCode: alpha.accessCode, autoCheckIn: true }, alpha.staffToken).expect(
        200,
      )

      const second = await verify(
        { accessCode: alpha.accessCode, autoCheckIn: true },
        alpha.staffToken,
      ).expect(200)

      expect(second.body.checkIn).toBe('already_checked_in')
      expect(await checkInHistory(alpha.bookingId)).toBe(1)
    })

    it('rejects a body carrying both credentials', async () => {
      await verify(
        { payload: livePayload(alpha), accessCode: alpha.accessCode },
        alpha.staffToken,
      ).expect(400)
    })
  })

  describe('secret containment', () => {
    it('never puts qrSecret in any response that touches the booking', async () => {
      const owner = (path: string) =>
        request(app.getHttpServer())
          .get(`${API}${path}`)
          .set('authorization', `Bearer ${alpha.ownerToken}`)

      const responses = [
        await verify({ payload: livePayload(alpha) }, alpha.staffToken).expect(200),
        await owner(`/bookings/${alpha.bookingId}`).expect(200),
        await owner('/bookings/mine').expect(200),
        await owner(`/bookings/${alpha.bookingId}/qr`).expect(200),
      ]

      for (const response of responses) {
        expect(response.text).not.toContain(alpha.qrSecret)
        expect(response.text).not.toContain('qrSecret')
      }
    })

    it('issues the owner a code the scanner accepts, so the contract round-trips', async () => {
      const issued = await request(app.getHttpServer())
        .get(`${API}/bookings/${alpha.bookingId}/qr`)
        .set('authorization', `Bearer ${alpha.ownerToken}`)
        .expect(200)

      expect(issued.body.payload).toBe(
        buildQrPayload(alpha.qrSecret, alpha.bookingId, issued.body.unixMinute),
      )

      const scanned = await verify({ payload: issued.body.payload }, alpha.staffToken).expect(200)
      expect(scanned.body.verdict).toBe('valid')
    })

    it('refuses to issue a code for somebody else booking', async () => {
      await request(app.getHttpServer())
        .get(`${API}/bookings/${beta.bookingId}/qr`)
        .set('authorization', `Bearer ${alpha.ownerToken}`)
        .expect(404)
    })
  })
})
