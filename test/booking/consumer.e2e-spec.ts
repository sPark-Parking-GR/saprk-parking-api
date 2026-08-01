import { BookingStatus, FacilityKind, UserRole } from '@prisma/client'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import request from 'supertest'
import type { PrismaService } from '../../src/prisma/prisma.service'
import { bearerToken } from '../utils/auth'
import { truncateAll } from '../utils/db'
import {
  UNCLAIMED_OPERATOR_ID,
  seedBooking,
  seedFacility,
  seedOperator,
  seedUnclaimedOperator,
  seedUser,
} from '../utils/seed'
import { resetThrottle } from '../utils/throttle'
import { createTestApp } from '../utils/test-app'

const API = '/api/v1'

describe('consumer app endpoints (e2e)', () => {
  let app: NestFastifyApplication
  let prisma: PrismaService

  let facilityId: string
  let otherFacilityId: string
  let meToken: string
  let themToken: string
  let myBookingIds: string[]
  let theirBookingId: string

  beforeAll(async () => {
    const testApp = await createTestApp()
    app = testApp.app
    prisma = testApp.prisma
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(async () => {
    await truncateAll(prisma)
    resetThrottle(app)

    // The unclaimed-import operator is the only one exempt from the one-facility-per-operator
    // partial unique index, so it is how a fixture gets two facilities to bookmark.
    await seedUnclaimedOperator(prisma)
    const [operator, facility, otherFacility] = await Promise.all([
      seedOperator(prisma, { name: 'Consumer ops' }),
      seedFacility(prisma, {
        operatorId: UNCLAIMED_OPERATOR_ID,
        name: 'Saved one',
        lat: 37.9838,
        lng: 23.7275,
      }),
      seedFacility(prisma, {
        operatorId: UNCLAIMED_OPERATOR_ID,
        name: 'Saved two',
        lat: 37.99,
        lng: 23.73,
      }),
    ])
    facilityId = facility.id
    otherFacilityId = otherFacility.id

    const bookingFacility = await seedFacility(prisma, {
      operatorId: operator.id,
      name: 'Booked',
      lat: 38.0,
      lng: 23.74,
    })

    const [me, them] = await Promise.all([seedUser(prisma), seedUser(prisma)])
    meToken = bearerToken(me)
    themToken = bearerToken(them)

    const mine = []
    for (const [index, day] of [3, 1, 2].entries()) {
      mine.push(
        await seedBooking(prisma, {
          facilityId: bookingFacility.id,
          userId: me.id,
          startsAt: new Date(`2026-08-0${day}T10:00:00.000Z`),
          endsAt: new Date(`2026-08-0${day}T12:00:00.000Z`),
          status: index === 0 ? BookingStatus.CHECKED_OUT : BookingStatus.CONFIRMED,
        }),
      )
    }
    myBookingIds = mine.map((booking) => booking.id)

    const theirs = await seedBooking(prisma, {
      facilityId: bookingFacility.id,
      userId: them.id,
      startsAt: new Date('2026-08-04T10:00:00.000Z'),
      endsAt: new Date('2026-08-04T12:00:00.000Z'),
    })
    theirBookingId = theirs.id
  })

  function get(path: string, token?: string) {
    const call = request(app.getHttpServer()).get(`${API}${path}`)
    return token ? call.set('authorization', `Bearer ${token}`) : call
  }

  function post(path: string, body: object, token?: string) {
    const call = request(app.getHttpServer()).post(`${API}${path}`).send(body)
    return token ? call.set('authorization', `Bearer ${token}`) : call
  }

  describe('GET /bookings/mine', () => {
    it('returns only the caller own bookings, newest stay first', async () => {
      const response = await get('/bookings/mine', meToken).expect(200)

      expect(response.body.total).toBe(3)
      expect(response.body.items.map((item: { id: string }) => item.id)).not.toContain(
        theirBookingId,
      )
      expect(response.body.items.map((item: { startsAt: string }) => item.startsAt)).toEqual([
        '2026-08-03T10:00:00.000Z',
        '2026-08-02T10:00:00.000Z',
        '2026-08-01T10:00:00.000Z',
      ])
    })

    it('does not leak another account bookings through pagination or filters', async () => {
      const page = await get('/bookings/mine?skip=0&take=100', themToken).expect(200)

      expect(page.body.total).toBe(1)
      expect(page.body.items[0].id).toBe(theirBookingId)
    })

    it('pages with the same contract as the ops board', async () => {
      const response = await get('/bookings/mine?skip=1&take=1', meToken).expect(200)

      expect(response.body).toMatchObject({ total: 3, skip: 1, take: 1 })
      expect(response.body.items).toHaveLength(1)
    })

    it('filters by status', async () => {
      const response = await get('/bookings/mine?status=CHECKED_OUT', meToken).expect(200)

      expect(response.body.total).toBe(1)
      expect(response.body.items[0].id).toBe(myBookingIds[0])
    })

    it('is closed to anonymous callers', async () => {
      await get('/bookings/mine').expect(401)
    })

    it('is not shadowed by the booking detail route', async () => {
      const detail = await get(`/bookings/${myBookingIds[0]}`, meToken).expect(200)

      expect(detail.body.id).toBe(myBookingIds[0])
    })
  })

  describe('saved facilities', () => {
    it('saves, lists and unsaves within the caller own rows', async () => {
      await post('/saved-facilities', { facilityId }, meToken).expect(201)

      const listed = await get('/saved-facilities', meToken).expect(200)
      expect(listed.body.total).toBe(1)
      expect(listed.body.items[0]).toMatchObject({ facilityId, available: true })

      await request(app.getHttpServer())
        .delete(`${API}/saved-facilities/${facilityId}`)
        .set('authorization', `Bearer ${meToken}`)
        .expect(204)

      const after = await get('/saved-facilities', meToken).expect(200)
      expect(after.body.total).toBe(0)
    })

    it('treats a repeated save as the same bookmark, not a conflict', async () => {
      await post('/saved-facilities', { facilityId }, meToken).expect(201)
      await post('/saved-facilities', { facilityId }, meToken).expect(201)

      const listed = await get('/saved-facilities', meToken).expect(200)
      expect(listed.body.total).toBe(1)
    })

    it('treats a repeated unsave as a no-op', async () => {
      await request(app.getHttpServer())
        .delete(`${API}/saved-facilities/${facilityId}`)
        .set('authorization', `Bearer ${meToken}`)
        .expect(204)
    })

    it('keeps a later-archived facility in the list, flagged unavailable', async () => {
      await post('/saved-facilities', { facilityId }, meToken).expect(201)
      await post('/saved-facilities', { facilityId: otherFacilityId }, meToken).expect(201)

      await prisma.facility.update({ where: { id: facilityId }, data: { isActive: false } })
      await prisma.facility.update({
        where: { id: otherFacilityId },
        data: { kind: FacilityKind.RESTRICTED },
      })

      const listed = await get('/saved-facilities', meToken).expect(200)

      expect(listed.body.total).toBe(2)
      expect(listed.body.items.every((item: { available: boolean }) => !item.available)).toBe(true)
    })

    it('drops the bookmark when the facility itself is deleted', async () => {
      await post('/saved-facilities', { facilityId }, meToken).expect(201)

      await prisma.facility.delete({ where: { id: facilityId } })

      const listed = await get('/saved-facilities', meToken).expect(200)
      expect(listed.body.total).toBe(0)
    })

    it('scopes the list to the caller', async () => {
      await post('/saved-facilities', { facilityId }, meToken).expect(201)

      const theirs = await get('/saved-facilities', themToken).expect(200)
      expect(theirs.body.total).toBe(0)
    })

    it('does not let one account unsave another account bookmark', async () => {
      await post('/saved-facilities', { facilityId }, meToken).expect(201)

      await request(app.getHttpServer())
        .delete(`${API}/saved-facilities/${facilityId}`)
        .set('authorization', `Bearer ${themToken}`)
        .expect(204)

      const mine = await get('/saved-facilities', meToken).expect(200)
      expect(mine.body.total).toBe(1)
    })

    it('refuses to save a facility that is not publicly visible', async () => {
      await prisma.facility.update({ where: { id: facilityId }, data: { isVerified: false } })

      await post('/saved-facilities', { facilityId }, meToken).expect(404)
      await post('/saved-facilities', { facilityId: 'no-such-facility' }, meToken).expect(404)
    })

    it('is closed to anonymous callers', async () => {
      await get('/saved-facilities').expect(401)
      await post('/saved-facilities', { facilityId }).expect(401)
    })
  })
})

describe('consumer app roles (e2e)', () => {
  it('admits an operator account to its own trips list', async () => {
    const { app, prisma } = await createTestApp()
    try {
      await truncateAll(prisma)
      const operator = await seedOperator(prisma, { name: 'Role check' })
      const staff = await seedUser(prisma, {
        role: UserRole.OPERATOR_STAFF,
        operatorId: operator.id,
      })

      const response = await request(app.getHttpServer())
        .get(`${API}/bookings/mine`)
        .set('authorization', `Bearer ${bearerToken(staff)}`)
        .expect(200)

      expect(response.body.total).toBe(0)
    } finally {
      await app.close()
    }
  })
})
