import {
  LifecycleStatus,
  PrismaClient,
  SubscriptionStatus,
  UserRole,
  type ParkingOperator,
  type User,
} from '@prisma/client'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import request from 'supertest'
import type { PrismaService } from '../../src/prisma/prisma.service'
import { bearerToken } from '../utils/auth'
import { truncateAll } from '../utils/db'
import {
  seedFacility,
  seedOperator,
  seedOperatorSubscription,
  seedSubscriptionPlan,
  seedTariffPlan,
  seedUnclaimedOperator,
  seedUser,
  STARTER_PLAN_ID,
  UNCLAIMED_OPERATOR_ID,
} from '../utils/seed'
import { createTestApp } from '../utils/test-app'
import { resetThrottle } from '../utils/throttle'

const API = '/api/v1'
const SUBS = `${API}/admin/subscriptions`
const CENTRE = { lat: 37.9838, lng: 23.7275 }

let seq = 0

function facilityBody(over: Record<string, unknown> = {}) {
  seq += 1
  return {
    name: `Facility ${seq}`,
    address: `${seq} Test Street`,
    lat: CENTRE.lat,
    lng: CENTRE.lng,
    totalCapacity: 50,
    onlineQuota: 10,
    vehicleTypes: ['car'],
    openingHours: { is24h: true },
    amenities: [],
    cancellationPolicy: 'FLEXIBLE',
    ...over,
  }
}

function tariffDraft(over: Record<string, unknown> = {}) {
  seq += 1
  return {
    name: `Plan ${seq}`,
    isActive: true,
    isDefault: false,
    validFrom: null,
    validTo: null,
    timezone: 'Europe/Athens',
    graceMinutes: 0,
    incrementMinutes: 60,
    vehicleTypes: ['car'],
    tiers: [{ key: 't', fromMinute: 0, toMinute: null, unit: 'per_block', blockMinutes: 60 }],
    windows: [{ key: 'all', label: 'All', dayMask: 127, startMinute: 0, endMinute: 1440 }],
    rates: [{ tierKey: 't', windowKey: 'all', priceCents: 300, currency: 'EUR' }],
    caps: [],
    ...over,
  }
}

/**
 * Entitlements over real Postgres. The unit specs prove the counting rules against mocks;
 * this suite proves that the migration, the dropped index, the Prisma extension and the
 * write paths actually agree once a real database is underneath them.
 */
describe('subscription entitlements (e2e)', () => {
  let app: NestFastifyApplication
  let prisma: PrismaService
  // Unextended client: writes and reads the non-ACTIVE lifecycle states the extended
  // client hides, which is how the archived-facility case is set up.
  let raw: PrismaClient

  let platformAdmin: User
  let platformToken: string

  beforeAll(async () => {
    const testApp = await createTestApp()
    app = testApp.app
    prisma = testApp.prisma
    raw = new PrismaClient()
    await raw.$connect()
  })

  afterAll(async () => {
    await raw.$disconnect()
    await app.close()
  })

  beforeEach(async () => {
    await truncateAll(prisma)
    resetThrottle(app)
    platformAdmin = await seedUser(prisma, { role: UserRole.PLATFORM_ADMIN })
    platformToken = bearerToken(platformAdmin)
  })

  function post(path: string, token: string, body: object) {
    return request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${token}`)
      .send(body)
  }

  function put(path: string, token: string, body: object) {
    return request(app.getHttpServer()).put(path).set('Authorization', `Bearer ${token}`).send(body)
  }

  function get(path: string, token: string) {
    return request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`)
  }

  async function operatorWithAdmin(): Promise<{ operator: ParkingOperator; token: string }> {
    const operator = await seedOperator(prisma)
    const admin = await seedUser(prisma, {
      role: UserRole.OPERATOR_ADMIN,
      operatorId: operator.id,
    })
    return { operator, token: bearerToken(admin) }
  }

  function createFacility(token: string, operatorId?: string) {
    return post(`${API}/facilities`, token, facilityBody(operatorId ? { operatorId } : {}))
  }

  describe('facility quota replaces the hardcoded cap', () => {
    it('admits the first facility on the Starter plan', async () => {
      const { token } = await operatorWithAdmin()

      await createFacility(token).expect(201)
    })

    // The refusal must come from entitlements, not from the removed cap or a raw P2002.
    it('refuses a second facility with the entitlement error, naming the limit', async () => {
      const { operator, token } = await operatorWithAdmin()
      await seedOperatorSubscription(raw, { operatorId: operator.id, planId: STARTER_PLAN_ID })

      await createFacility(token).expect(201)
      const refused = await createFacility(token).expect(409)

      // Singular, because the limit is one. The message agrees with its own numbers now.
      expect(refused.body.message).toContain('plan allows 1 facility')
      expect(refused.body.message).toContain('1 is already in use')
      expect(refused.body.message).not.toContain('may own only one')
      // And the refusal is machine-readable, so the web app no longer has to recognise a
      // plan limit by pattern-matching this English sentence.
      expect(refused.body).toMatchObject({
        code: 'ENTITLEMENT_LIMIT_EXCEEDED',
        resource: 'facilities',
        limit: 1,
        current: 1,
      })
      expect(await raw.facility.count({ where: { operatorId: operator.id } })).toBe(1)
    })

    it('allows the second facility once the plan is raised', async () => {
      const { operator, token } = await operatorWithAdmin()
      await createFacility(token).expect(201)
      await createFacility(token).expect(409)

      const growth = await seedSubscriptionPlan(raw, {
        id: 'plan_growth',
        code: 'growth',
        name: 'Growth',
        maxFacilities: 5,
      })
      await put(`${SUBS}/operators/${operator.id}`, platformToken, {
        planId: growth.id,
      }).expect(200)

      await createFacility(token).expect(201)
      expect(await raw.facility.count({ where: { operatorId: operator.id } })).toBe(2)
    })

    it('lets a per-operator override beat the plan', async () => {
      const { operator, token } = await operatorWithAdmin()
      await seedOperatorSubscription(raw, { operatorId: operator.id, planId: STARTER_PLAN_ID })
      await createFacility(token).expect(201)
      await createFacility(token).expect(409)

      await put(`${SUBS}/operators/${operator.id}/override`, platformToken, {
        entitlementOverride: { maxFacilities: 3 },
      }).expect(200)

      await createFacility(token).expect(201)
      await createFacility(token).expect(201)
      await createFacility(token).expect(409)
    })

    /**
     * The predicate question, settled against a real database: the dropped index counted
     * only lifecycle-ACTIVE rows, so archiving must free the slot. Getting this wrong in
     * either direction gives an operator a phantom slot or silently takes a real one.
     */
    it('does not count archived facilities against the quota', async () => {
      const { operator, token } = await operatorWithAdmin()
      const first = await createFacility(token).expect(201)
      await createFacility(token).expect(409)

      await raw.facility.update({
        where: { id: first.body.id },
        data: { lifecycleStatus: LifecycleStatus.ARCHIVED },
      })

      await createFacility(token).expect(201)

      const rows = await raw.facility.findMany({ where: { operatorId: operator.id } })
      expect(rows).toHaveLength(2)
      expect(rows.filter((r) => r.lifecycleStatus === LifecycleStatus.ACTIVE)).toHaveLength(1)
    })
  })

  describe('the unclaimed-import operator is outside billing', () => {
    // ~1,500 ingested facilities live under it. It is an ingestion artifact, not a customer.
    it('is exempt at a volume far past any plan limit, with no subscription row', async () => {
      await seedUnclaimedOperator(prisma)

      for (let i = 0; i < 5; i += 1) {
        await seedFacility(raw, { operatorId: UNCLAIMED_OPERATOR_ID, ...CENTRE })
      }

      const admin = await seedUser(prisma, {
        role: UserRole.OPERATOR_ADMIN,
        operatorId: UNCLAIMED_OPERATOR_ID,
      })
      await createFacility(bearerToken(admin), UNCLAIMED_OPERATOR_ID).expect(201)

      expect(await raw.facility.count({ where: { operatorId: UNCLAIMED_OPERATOR_ID } })).toBe(6)
      expect(
        await raw.operatorSubscription.count({ where: { operatorId: UNCLAIMED_OPERATOR_ID } }),
      ).toBe(0)
    })

    it('reports as exempt with unlimited entitlements on the admin surface', async () => {
      await seedUnclaimedOperator(prisma)

      const response = await get(
        `${SUBS}/operators/${UNCLAIMED_OPERATOR_ID}`,
        platformToken,
      ).expect(200)

      expect(response.body.source).toBe('exempt')
      expect(response.body.entitlements.maxFacilities).toBeNull()
    })

    // The exemption is checked before the catalog is read, so a broken catalog cannot
    // wedge the ingestion pipeline.
    it('stays exempt even with no default plan in the catalog', async () => {
      await seedUnclaimedOperator(prisma)
      await raw.subscriptionPlan.deleteMany({})

      const admin = await seedUser(prisma, {
        role: UserRole.OPERATOR_ADMIN,
        operatorId: UNCLAIMED_OPERATOR_ID,
      })
      await createFacility(bearerToken(admin), UNCLAIMED_OPERATOR_ID).expect(201)
    })
  })

  describe('downgrades fail loudly', () => {
    it('refuses a plan change below current usage, naming exactly what to remove', async () => {
      const { operator, token } = await operatorWithAdmin()
      const growth = await seedSubscriptionPlan(raw, {
        id: 'plan_growth',
        code: 'growth',
        name: 'Growth',
        maxFacilities: 5,
      })
      await seedOperatorSubscription(raw, { operatorId: operator.id, planId: growth.id })

      await createFacility(token).expect(201)
      await createFacility(token).expect(201)
      await createFacility(token).expect(201)

      const refused = await put(`${SUBS}/operators/${operator.id}`, platformToken, {
        planId: STARTER_PLAN_ID,
      }).expect(409)

      expect(refused.body.message).toContain('3 facilities exceed the plan limit of 1')
      expect(refused.body.message).toContain('remove 2 first')
      expect(refused.body.violations).toEqual([
        { resource: 'facilities', limit: 1, current: 3, remove: 2 },
      ])
    })

    // Never enforce by deleting customer data, and never leave them over quota unsignalled.
    it('leaves the subscription and the data untouched when it refuses', async () => {
      const { operator, token } = await operatorWithAdmin()
      const growth = await seedSubscriptionPlan(raw, {
        id: 'plan_growth',
        code: 'growth',
        name: 'Growth',
        maxFacilities: 5,
      })
      await seedOperatorSubscription(raw, { operatorId: operator.id, planId: growth.id })
      await createFacility(token).expect(201)
      await createFacility(token).expect(201)

      await put(`${SUBS}/operators/${operator.id}`, platformToken, {
        planId: STARTER_PLAN_ID,
      }).expect(409)

      const subscription = await raw.operatorSubscription.findFirstOrThrow({
        where: { operatorId: operator.id },
      })
      expect(subscription.planId).toBe(growth.id)
      expect(await raw.facility.count({ where: { operatorId: operator.id } })).toBe(2)
    })

    it('admits the downgrade once the operator is back within the limit', async () => {
      const { operator, token } = await operatorWithAdmin()
      const growth = await seedSubscriptionPlan(raw, {
        id: 'plan_growth',
        code: 'growth',
        name: 'Growth',
        maxFacilities: 5,
      })
      await seedOperatorSubscription(raw, { operatorId: operator.id, planId: growth.id })
      const first = await createFacility(token).expect(201)
      await createFacility(token).expect(201)

      await put(`${SUBS}/operators/${operator.id}`, platformToken, {
        planId: STARTER_PLAN_ID,
      }).expect(409)

      await raw.facility.update({
        where: { id: first.body.id },
        data: { lifecycleStatus: LifecycleStatus.ARCHIVED },
      })

      await put(`${SUBS}/operators/${operator.id}`, platformToken, {
        planId: STARTER_PLAN_ID,
      }).expect(200)
    })

    it('refuses an override that drops a limit below current usage', async () => {
      const { operator, token } = await operatorWithAdmin()
      const growth = await seedSubscriptionPlan(raw, {
        id: 'plan_growth',
        code: 'growth',
        name: 'Growth',
        maxFacilities: 5,
      })
      await seedOperatorSubscription(raw, { operatorId: operator.id, planId: growth.id })
      await createFacility(token).expect(201)
      await createFacility(token).expect(201)

      await put(`${SUBS}/operators/${operator.id}/override`, platformToken, {
        entitlementOverride: { maxFacilities: 1 },
      }).expect(409)
    })
  })

  describe('tariff plan and staff seat quotas', () => {
    it('refuses a tariff plan past the plan limit', async () => {
      const { operator, token } = await operatorWithAdmin()
      const capped = await seedSubscriptionPlan(raw, {
        id: 'plan_capped',
        code: 'capped',
        name: 'Capped',
        maxTariffPlans: 1,
      })
      await seedOperatorSubscription(raw, { operatorId: operator.id, planId: capped.id })
      await seedTariffPlan(raw, { operatorId: operator.id })

      const refused = await post(`${API}/tariff-plans`, token, tariffDraft()).expect(409)

      expect(refused.body.message).toContain('1 tariff plan and 1 is already in use')
    })

    it('refuses a member invite past the staff seat limit', async () => {
      const { operator, token } = await operatorWithAdmin()
      const capped = await seedSubscriptionPlan(raw, {
        id: 'plan_seats',
        code: 'seats',
        name: 'Seats',
        maxStaffSeats: 1,
      })
      await seedOperatorSubscription(raw, { operatorId: operator.id, planId: capped.id })

      // The seeded operator admin already occupies the single seat.
      const refused = await post(`${API}/invites/members`, token, {
        email: 'new.staff@e2e.invalid',
        role: 'STAFF',
        operatorId: operator.id,
      }).expect(409)

      expect(refused.body.message).toContain('1 staff seat and 1 is already in use')
    })
  })

  describe('admin surface authorization', () => {
    it('admits a platform administrator holding billing.manage', async () => {
      const response = await get(`${SUBS}/plans`, platformToken).expect(200)
      expect(response.body).toHaveLength(1)
      expect(response.body[0].code).toBe('starter')
    })

    it.each([
      ['operator_admin', UserRole.OPERATOR_ADMIN],
      ['operator_staff', UserRole.OPERATOR_STAFF],
      ['user', UserRole.USER],
    ])('refuses %s on every route', async (_label, role) => {
      const operator = await seedOperator(prisma)
      const caller = await seedUser(prisma, { role, operatorId: operator.id })
      const token = bearerToken(caller)

      await get(`${SUBS}/plans`, token).expect(403)
      await post(`${SUBS}/plans`, token, {
        code: 'sneaky',
        name: 'Sneaky',
        priceCents: 0,
        entitlements: {
          maxFacilities: 99,
          maxTariffPlans: null,
          maxStaffSeats: null,
          features: [],
          commissionBps: 0,
        },
      }).expect(403)
      await get(`${SUBS}/operators/${operator.id}`, token).expect(403)
      await put(`${SUBS}/operators/${operator.id}`, token, {
        planId: STARTER_PLAN_ID,
      }).expect(403)
      await put(`${SUBS}/operators/${operator.id}/override`, token, {
        entitlementOverride: { maxFacilities: 99 },
      }).expect(403)

      expect(await raw.subscriptionPlan.count()).toBe(1)
    })

    it('refuses an unauthenticated caller with 401, not 403', async () => {
      await request(app.getHttpServer()).get(`${SUBS}/plans`).expect(401)
    })

    // An operator admin must not be able to lift their own limit by any route.
    it('does not let an operator admin raise their own quota', async () => {
      const { operator, token } = await operatorWithAdmin()
      await createFacility(token).expect(201)

      await put(`${SUBS}/operators/${operator.id}/override`, token, {
        entitlementOverride: { maxFacilities: 10 },
      }).expect(403)

      await createFacility(token).expect(409)
    })
  })

  describe('plan catalog', () => {
    it('validates entitlements at the write boundary and rejects unknown keys', async () => {
      await post(`${SUBS}/plans`, platformToken, {
        code: 'typo',
        name: 'Typo',
        priceCents: 1_000,
        entitlements: {
          maxFacilties: 3,
          maxTariffPlans: null,
          maxStaffSeats: null,
          features: [],
          commissionBps: 0,
        },
      }).expect(400)
    })

    it('rejects a duplicate plan code', async () => {
      const body = {
        code: 'growth',
        name: 'Growth',
        priceCents: 4_900,
        entitlements: {
          maxFacilities: 5,
          maxTariffPlans: null,
          maxStaffSeats: null,
          features: [],
          commissionBps: 250,
        },
      }
      await post(`${SUBS}/plans`, platformToken, body).expect(201)
      await post(`${SUBS}/plans`, platformToken, body).expect(409)
    })

    it('stores price as integer cents and a commission in basis points', async () => {
      const created = await post(`${SUBS}/plans`, platformToken, {
        code: 'scale',
        name: 'Scale',
        priceCents: 19_900,
        entitlements: {
          maxFacilities: 50,
          maxTariffPlans: null,
          maxStaffSeats: null,
          features: ['analytics.advanced'],
          commissionBps: 175,
        },
      }).expect(201)

      expect(created.body.priceCents).toBe(19_900)
      expect(created.body.entitlements.commissionBps).toBe(175)
      const row = await raw.subscriptionPlan.findFirstOrThrow({ where: { code: 'scale' } })
      expect(Number.isInteger(row.priceCents)).toBe(true)
    })

    it('archives a plan rather than deleting it, and refuses while it has subscribers', async () => {
      const operator = await seedOperator(prisma)
      const growth = await seedSubscriptionPlan(raw, {
        id: 'plan_growth',
        code: 'growth',
        name: 'Growth',
        maxFacilities: 5,
      })
      await seedOperatorSubscription(raw, { operatorId: operator.id, planId: growth.id })

      await post(`${SUBS}/plans/${growth.id}/archive`, platformToken, {}).expect(409)

      await raw.operatorSubscription.updateMany({
        where: { planId: growth.id },
        data: { status: SubscriptionStatus.CANCELLED },
      })
      await post(`${SUBS}/plans/${growth.id}/archive`, platformToken, {
        reason: 'retired',
      }).expect(200)

      const row = await raw.subscriptionPlan.findFirstOrThrow({ where: { id: growth.id } })
      expect(row.lifecycleStatus).toBe(LifecycleStatus.ARCHIVED)
      expect(row.lifecycleChangedBy).toBe(platformAdmin.id)
    })

    it('refuses to archive the default plan everything falls back to', async () => {
      await post(`${SUBS}/plans/${STARTER_PLAN_ID}/archive`, platformToken, {}).expect(409)
    })

    it('hides archived plans from the catalog unless asked', async () => {
      const retired = await seedSubscriptionPlan(raw, {
        id: 'plan_old',
        code: 'old',
        name: 'Old',
      })
      await post(`${SUBS}/plans/${retired.id}/archive`, platformToken, {}).expect(200)

      const listed = await get(`${SUBS}/plans`, platformToken).expect(200)
      expect(listed.body.map((p: { code: string }) => p.code)).toEqual(['starter'])

      const all = await get(`${SUBS}/plans?includeArchived=true`, platformToken).expect(200)
      expect(all.body).toHaveLength(2)
    })
  })

  describe('effective entitlements', () => {
    it('falls back to the default plan for an operator with no subscription', async () => {
      const operator = await seedOperator(prisma)

      const response = await get(`${SUBS}/operators/${operator.id}`, platformToken).expect(200)

      expect(response.body.source).toBe('default')
      expect(response.body.planCode).toBe('starter')
      expect(response.body.entitlements.maxFacilities).toBe(1)
      expect(response.body.usage).toEqual({ facilities: 0, tariffPlans: 0, staffSeats: 0 })
    })

    it('reports the live plan, the override and the resulting usage', async () => {
      const { operator, token } = await operatorWithAdmin()
      await seedOperatorSubscription(raw, { operatorId: operator.id, planId: STARTER_PLAN_ID })
      await createFacility(token).expect(201)

      await put(`${SUBS}/operators/${operator.id}/override`, platformToken, {
        entitlementOverride: { maxFacilities: 4 },
      }).expect(200)

      const response = await get(`${SUBS}/operators/${operator.id}`, platformToken).expect(200)

      expect(response.body.source).toBe('subscription+override')
      expect(response.body.entitlements.maxFacilities).toBe(4)
      expect(response.body.usage.facilities).toBe(1)
      expect(response.body.usage.staffSeats).toBe(1)
      expect(response.body.providerSubscriptionId).toBeNull()
    })

    it('keeps at most one live subscription per operator', async () => {
      const operator = await seedOperator(prisma)
      const growth = await seedSubscriptionPlan(raw, {
        id: 'plan_growth',
        code: 'growth',
        name: 'Growth',
        maxFacilities: 5,
      })

      await put(`${SUBS}/operators/${operator.id}`, platformToken, {
        planId: STARTER_PLAN_ID,
      }).expect(200)
      await put(`${SUBS}/operators/${operator.id}`, platformToken, {
        planId: growth.id,
      }).expect(200)

      const live = await raw.operatorSubscription.findMany({
        where: { operatorId: operator.id, status: { not: SubscriptionStatus.CANCELLED } },
      })
      expect(live).toHaveLength(1)
      expect(live[0]!.planId).toBe(growth.id)
    })

    // PAST_DUE is deliberately live: a failed charge starts dunning, it does not revoke a
    // paying tenant's limits mid-cycle.
    it('still grants the plan while a subscription is PAST_DUE', async () => {
      const operator = await seedOperator(prisma)
      const growth = await seedSubscriptionPlan(raw, {
        id: 'plan_growth',
        code: 'growth',
        name: 'Growth',
        maxFacilities: 5,
      })
      await seedOperatorSubscription(raw, {
        operatorId: operator.id,
        planId: growth.id,
        status: SubscriptionStatus.PAST_DUE,
      })

      const response = await get(`${SUBS}/operators/${operator.id}`, platformToken).expect(200)

      expect(response.body.status).toBe(SubscriptionStatus.PAST_DUE)
      expect(response.body.entitlements.maxFacilities).toBe(5)
    })
  })
})
