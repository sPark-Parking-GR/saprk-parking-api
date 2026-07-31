import { BookingStatus, UserRole } from '@prisma/client'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import request from 'supertest'
import type { PrismaService } from '../../src/prisma/prisma.service'
import { bearerToken } from '../utils/auth'
import { truncateAll } from '../utils/db'
import {
  seedBooking,
  seedFacility,
  seedOperator,
  seedOwnership,
  seedPayment,
  seedTariffPlan,
  seedUser,
} from '../utils/seed'
import { createTestApp } from '../utils/test-app'

const API = '/api/v1'
const FROM = '2026-06-01T00:00:00.000Z'
const TO = '2026-06-08T00:00:00.000Z'
const SETTLED_AT = new Date('2026-06-02T12:00:00.000Z')
const OWNED_SINCE = new Date('2026-01-01T00:00:00.000Z')

const MAP_BOUNDS = { north: 38.2, south: 37.8, east: 24.0, west: 23.5 }

interface Tenant {
  operatorId: string
  facilityId: string
  bookingId: string
  tariffPlanId: string
  token: string
  revenueCents: number
}

describe('tenancy isolation (e2e)', () => {
  let app: NestFastifyApplication
  let prisma: PrismaService

  let alpha: Tenant
  let beta: Tenant
  let platformToken: string
  let consumerToken: string

  beforeAll(async () => {
    const testApp = await createTestApp()
    app = testApp.app
    prisma = testApp.prisma
  })

  afterAll(async () => {
    await app.close()
  })

  async function seedTenant(name: string, lng: number, revenueCents: number): Promise<Tenant> {
    const operator = await seedOperator(prisma, { name })
    const facility = await seedFacility(prisma, {
      operatorId: operator.id,
      name: `${name} facility`,
      lat: 37.9838,
      lng,
    })
    await seedOwnership(prisma, {
      facilityId: facility.id,
      operatorId: operator.id,
      from: OWNED_SINCE,
    })

    const [admin, customer, plan] = await Promise.all([
      seedUser(prisma, { role: UserRole.OPERATOR_ADMIN, operatorId: operator.id }),
      seedUser(prisma),
      seedTariffPlan(prisma, { operatorId: operator.id, name: `${name} plan` }),
    ])

    const booking = await seedBooking(prisma, {
      facilityId: facility.id,
      userId: customer.id,
      startsAt: new Date('2026-06-02T10:00:00.000Z'),
      endsAt: new Date('2026-06-02T12:00:00.000Z'),
      status: BookingStatus.CONFIRMED,
    })
    await seedPayment(prisma, {
      bookingId: booking.id,
      amountCents: revenueCents,
      createdAt: SETTLED_AT,
    })

    return {
      operatorId: operator.id,
      facilityId: facility.id,
      bookingId: booking.id,
      tariffPlanId: plan.id,
      token: bearerToken(admin),
      revenueCents,
    }
  }

  beforeEach(async () => {
    await truncateAll(prisma)
    ;[alpha, beta] = await Promise.all([
      seedTenant('Alpha', 23.7275, 4_400),
      seedTenant('Beta', 23.7375, 9_900),
    ])
    const [platformAdmin, consumer] = await Promise.all([
      seedUser(prisma, { role: UserRole.PLATFORM_ADMIN }),
      seedUser(prisma, { role: UserRole.USER }),
    ])
    platformToken = bearerToken(platformAdmin)
    consumerToken = bearerToken(consumer)
  })

  function get(path: string, token?: string) {
    const call = request(app.getHttpServer()).get(`${API}${path}`)
    return token ? call.set('authorization', `Bearer ${token}`) : call
  }

  describe('facilities', () => {
    it('lists only the caller operator own facilities', async () => {
      const response = await get('/facilities', alpha.token).expect(200)

      expect(response.body.total).toBe(1)
      expect(response.body.items.map((item: { id: string }) => item.id)).toEqual([alpha.facilityId])
    })

    it('refuses to read another operator facility detail', async () => {
      await get(`/facilities/${alpha.facilityId}/manage`, alpha.token).expect(200)
      await get(`/facilities/${beta.facilityId}/manage`, alpha.token).expect(404)
    })

    it('scopes the admin map to the caller even when the rectangle covers both', async () => {
      const query = new URLSearchParams(
        Object.entries(MAP_BOUNDS).map<[string, string]>(([key, value]) => [key, String(value)]),
      )
      const response = await get(`/facilities/map?${query.toString()}`, alpha.token).expect(200)

      expect(response.body.total).toBe(1)
      expect(response.body.points.map((point: { id: string }) => point.id)).toEqual([
        alpha.facilityId,
      ])
    })

    it('ignores a requested operatorId that the caller does not belong to', async () => {
      const response = await get(`/facilities?operatorId=${beta.operatorId}`, alpha.token).expect(
        200,
      )

      expect(response.body.items.map((item: { id: string }) => item.id)).toEqual([alpha.facilityId])
    })

    it('lets a platform admin see every operator', async () => {
      const response = await get('/facilities', platformToken).expect(200)

      expect(response.body.total).toBe(2)
    })
  })

  describe('bookings', () => {
    it('lists only bookings at the caller own facilities', async () => {
      const response = await get('/bookings', alpha.token).expect(200)

      expect(response.body.total).toBe(1)
      expect(response.body.items.map((item: { id: string }) => item.id)).toEqual([alpha.bookingId])
    })

    it('returns nothing when narrowing to another operator facility', async () => {
      const response = await get(`/bookings?facilityId=${beta.facilityId}`, alpha.token).expect(200)

      expect(response.body.total).toBe(0)
      expect(response.body.items).toEqual([])
    })

    it('refuses to read another operator booking', async () => {
      await get(`/bookings/${beta.bookingId}`, alpha.token).expect(404)
    })
  })

  describe('tariff plans', () => {
    it('lists only the caller own plans', async () => {
      const response = await get('/tariff-plans', alpha.token).expect(200)

      expect(response.body.items.map((item: { id: string }) => item.id)).toEqual([
        alpha.tariffPlanId,
      ])
    })

    it('refuses to read another operator plan', async () => {
      await get(`/tariff-plans/${beta.tariffPlanId}`, alpha.token).expect(404)
    })
  })

  describe('analytics', () => {
    it('reports only the caller own money', async () => {
      const response = await get(`/analytics/summary?from=${FROM}&to=${TO}`, alpha.token).expect(
        200,
      )

      expect(response.body.grossRevenueCents).toBe(alpha.revenueCents)
    })

    it('forbids narrowing to an operator the caller does not belong to', async () => {
      await get(
        `/analytics/summary?from=${FROM}&to=${TO}&operatorId=${beta.operatorId}`,
        alpha.token,
      ).expect(403)
    })

    it('attributes each facility to its own operator for a platform admin', async () => {
      const response = await get(
        `/analytics/top-facilities?from=${FROM}&to=${TO}&limit=10`,
        platformToken,
      ).expect(200)

      const byOperator = new Map<string, number>(
        response.body.items.map((item: { operatorId: string; netRevenueCents: number }) => [
          item.operatorId,
          item.netRevenueCents,
        ]),
      )

      expect(byOperator.get(alpha.operatorId)).toBe(alpha.revenueCents)
      expect(byOperator.get(beta.operatorId)).toBe(beta.revenueCents)
    })
  })

  describe('role and token gates', () => {
    it('rejects an anonymous caller on every operator-scoped read', async () => {
      await get('/facilities').expect(401)
      await get('/bookings').expect(401)
      await get('/tariff-plans').expect(401)
      await get(`/analytics/summary?from=${FROM}&to=${TO}`).expect(401)
    })

    it('forbids a consumer account from operator-scoped reads', async () => {
      await get('/facilities', consumerToken).expect(403)
      await get('/bookings', consumerToken).expect(403)
      await get('/tariff-plans', consumerToken).expect(403)
      await get(`/analytics/summary?from=${FROM}&to=${TO}`, consumerToken).expect(403)
    })

    it('rejects a token signed with the wrong secret', async () => {
      const forged = `${alpha.token.slice(0, -4)}0000`

      await get('/facilities', forged).expect(401)
    })

    it('rejects a token whose session was revoked after it was issued', async () => {
      await get('/facilities', alpha.token).expect(200)

      await prisma.user.updateMany({
        where: { operatorMemberships: { some: { operatorId: alpha.operatorId } } },
        data: { sessionsValidFrom: new Date(Date.now() + 60_000) },
      })

      await get('/facilities', alpha.token).expect(401)
    })
  })
})
