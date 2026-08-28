import {
  LifecycleStatus,
  OperatorMemberRole,
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
  seedUser,
  STARTER_PLAN_ID,
} from '../utils/seed'
import { createTestApp } from '../utils/test-app'
import { resetThrottle } from '../utils/throttle'

const API = '/api/v1'
const SELF = `${API}/operator-subscriptions`
const CENTRE = { lat: 37.9838, lng: 23.7275 }

const UPGRADE_ACTION = 'operator_subscription.upgrade_requested'

/**
 * The operator's own billing surface over real HTTP. The unit spec proves the resolution and
 * permission rules against mocks; this proves that the guards, the org-scope filtering and
 * the audit write actually agree once the real container and a real database are underneath.
 */
describe('operator self-serve subscriptions (e2e)', () => {
  let app: NestFastifyApplication
  let prisma: PrismaService
  // Unextended client: reads the audit rows and the non-ACTIVE lifecycle states the extended
  // client hides, which is how the archived-plan case is set up.
  let raw: PrismaClient

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
    // truncateAll restores the migration-seeded Starter plan, so the catalog is never empty.
    await truncateAll(prisma)
    resetThrottle(app)
  })

  function get(path: string, token?: string) {
    const call = request(app.getHttpServer()).get(path)
    return token ? call.set('Authorization', `Bearer ${token}`) : call
  }

  function post(path: string, token: string, body: object) {
    return request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${token}`)
      .send(body)
  }

  async function operatorWithAdmin(): Promise<{
    operator: ParkingOperator
    admin: User
    token: string
  }> {
    const operator = await seedOperator(prisma)
    const admin = await seedUser(prisma, {
      role: UserRole.OPERATOR_ADMIN,
      operatorId: operator.id,
    })
    return { operator, admin, token: bearerToken(admin) }
  }

  function growthPlan(over: Record<string, unknown> = {}) {
    return seedSubscriptionPlan(raw, {
      id: 'plan_growth',
      code: 'growth',
      name: 'Growth',
      maxFacilities: 5,
      priceCents: 4_900,
      ...over,
    })
  }

  describe('the public plan catalog', () => {
    it('answers an unauthenticated caller', async () => {
      const response = await get(`${SELF}/plans`).expect(200)

      expect(response.body).toHaveLength(1)
      expect(response.body[0].code).toBe('starter')
    })

    it('returns the published terms and no administration fields', async () => {
      const response = await get(`${SELF}/plans`).expect(200)

      expect(Object.keys(response.body[0]).sort()).toEqual([
        'code',
        'currency',
        'description',
        'entitlements',
        'id',
        'interval',
        'name',
        'priceCents',
      ])
      expect(response.body[0].entitlements).toEqual({
        maxFacilities: 1,
        maxTariffPlans: null,
        maxStaffSeats: null,
        features: [],
        commissionBps: 0,
      })
    })

    it('hides a sales-negotiated plan and an archived one', async () => {
      await growthPlan({ id: 'plan_private', code: 'private', name: 'Private' })
      await raw.subscriptionPlan.update({
        where: { id: 'plan_private' },
        data: { isPublic: false },
      })
      await growthPlan({ id: 'plan_old', code: 'old', name: 'Old' })
      await raw.subscriptionPlan.update({
        where: { id: 'plan_old' },
        data: { lifecycleStatus: LifecycleStatus.ARCHIVED },
      })

      const response = await get(`${SELF}/plans`).expect(200)

      expect(response.body.map((p: { code: string }) => p.code)).toEqual(['starter'])
    })
  })

  describe('reading my own plan', () => {
    it('reports the default plan, its limits and the operator’s usage', async () => {
      const { token } = await operatorWithAdmin()

      const response = await get(`${SELF}/me`, token).expect(200)

      expect(response.body).toEqual({
        planCode: 'starter',
        planName: 'Starter',
        status: null,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        trialEndsAt: null,
        cancelAtPeriodEnd: false,
        source: 'default',
        entitlements: {
          maxFacilities: 1,
          maxTariffPlans: null,
          maxStaffSeats: null,
          features: [],
          commissionBps: 0,
        },
        usage: { facilities: 0, tariffPlans: 0, staffSeats: 1 },
      })
    })

    it('reports a live subscription, its period and the usage against it', async () => {
      const { operator, token } = await operatorWithAdmin()
      const growth = await growthPlan()
      await seedOperatorSubscription(raw, { operatorId: operator.id, planId: growth.id })
      await seedFacility(raw, { operatorId: operator.id, ...CENTRE })

      const response = await get(`${SELF}/me`, token).expect(200)

      expect(response.body.planCode).toBe('growth')
      expect(response.body.status).toBe(SubscriptionStatus.ACTIVE)
      expect(response.body.source).toBe('subscription')
      expect(response.body.entitlements.maxFacilities).toBe(5)
      expect(response.body.usage.facilities).toBe(1)
      expect(typeof response.body.currentPeriodStart).toBe('string')
    })

    // The admin surface's own fields stay there: how sPark books the account is not a term
    // the customer bought.
    it('does not expose the entitlement override or the provider subscription id', async () => {
      const { operator, token } = await operatorWithAdmin()
      await seedOperatorSubscription(raw, {
        operatorId: operator.id,
        planId: STARTER_PLAN_ID,
        entitlementOverride: { maxFacilities: 4 },
      })

      const response = await get(`${SELF}/me`, token).expect(200)

      expect(response.body.source).toBe('subscription+override')
      expect(response.body.entitlements.maxFacilities).toBe(4)
      expect(response.body).not.toHaveProperty('entitlementOverride')
      expect(response.body).not.toHaveProperty('providerSubscriptionId')
      expect(response.body).not.toHaveProperty('operatorId')
    })

    it('refuses an unauthenticated caller with 401, not 403', async () => {
      await get(`${SELF}/me`).expect(401)
    })
  })

  describe('the permission boundary', () => {
    it('refuses a STAFF member of the same operator', async () => {
      const operator = await seedOperator(prisma)
      const staff = await seedUser(prisma, {
        role: UserRole.OPERATOR_STAFF,
        operatorId: operator.id,
        memberRole: OperatorMemberRole.STAFF,
      })
      const token = bearerToken(staff)

      await get(`${SELF}/me`, token).expect(403)
      await post(`${SELF}/upgrade-request`, token, {}).expect(403)
      expect(await raw.auditLog.count({ where: { action: UPGRADE_ACTION } })).toBe(0)
    })

    /**
     * The structural exclusion, over HTTP: scopesFor() filters `org:billing.view` out of a
     * STAFF membership at READ time, so a row that already carries it — however it was
     * written — still grants nothing.
     */
    it('refuses a STAFF member whose row already stores org:billing.view', async () => {
      const operator = await seedOperator(prisma)
      const staff = await seedUser(prisma, {
        role: UserRole.OPERATOR_STAFF,
        operatorId: operator.id,
        memberRole: OperatorMemberRole.STAFF,
      })
      await raw.operatorMembership.update({
        where: { operatorId_userId: { operatorId: operator.id, userId: staff.id } },
        data: { scopes: ['org:billing.view'] },
      })

      await get(`${SELF}/me`, bearerToken(staff)).expect(403)
    })

    it('refuses a plain consumer account', async () => {
      const consumer = await seedUser(prisma, { role: UserRole.USER })

      await get(`${SELF}/me`, bearerToken(consumer)).expect(403)
    })

    // A platform caller holds no membership, so "my operator" names nothing for them. Their
    // view of a tenant is GET admin/subscriptions/operators/:operatorId.
    it('refuses a platform administrator, who has the admin surface instead', async () => {
      const platformAdmin = await seedUser(prisma, { role: UserRole.PLATFORM_ADMIN })

      await get(`${SELF}/me`, bearerToken(platformAdmin)).expect(403)
    })

    // The route carries no operator id at all, so the only thing a caller could try is
    // smuggling one through the body — which the strict schema refuses outright.
    it('gives a caller no way to name another operator', async () => {
      const { token } = await operatorWithAdmin()
      const other = await seedOperator(prisma)

      await post(`${SELF}/upgrade-request`, token, { operatorId: other.id }).expect(400)

      expect(await raw.auditLog.count({ where: { entityId: other.id } })).toBe(0)
    })
  })

  describe('requesting an upgrade', () => {
    it('records the request against the caller’s operator and reports delivery', async () => {
      const { operator, admin, token } = await operatorWithAdmin()
      const growth = await growthPlan()

      const response = await post(`${SELF}/upgrade-request`, token, {
        requestedPlanId: growth.id,
        message: 'We are opening a second site in October.',
      }).expect(200)

      expect(response.body.delivered).toBe(true)

      const row = await raw.auditLog.findFirstOrThrow({ where: { action: UPGRADE_ACTION } })
      expect(row.id).toBe(response.body.requestId)
      expect(row.actorId).toBe(admin.id)
      expect(row.entityType).toBe('ParkingOperator')
      expect(row.entityId).toBe(operator.id)
      expect(row.payload).toEqual({
        requestedPlanId: growth.id,
        requestedPlanCode: 'growth',
        message: 'We are opening a second site in October.',
      })
    })

    it('accepts a request that names no plan', async () => {
      const { token } = await operatorWithAdmin()

      await post(`${SELF}/upgrade-request`, token, { message: 'Please call me.' }).expect(200)

      const row = await raw.auditLog.findFirstOrThrow({ where: { action: UPGRADE_ACTION } })
      expect(row.payload).toEqual({ message: 'Please call me.' })
    })

    it('refuses a plan that does not exist, and records nothing', async () => {
      const { token } = await operatorWithAdmin()

      await post(`${SELF}/upgrade-request`, token, { requestedPlanId: 'plan_ghost' }).expect(404)

      expect(await raw.auditLog.count({ where: { action: UPGRADE_ACTION } })).toBe(0)
    })

    it('refuses a sales-negotiated plan the operator was never offered', async () => {
      const { token } = await operatorWithAdmin()
      const secret = await growthPlan({ id: 'plan_secret', code: 'secret', name: 'Secret' })
      await raw.subscriptionPlan.update({ where: { id: secret.id }, data: { isPublic: false } })

      await post(`${SELF}/upgrade-request`, token, { requestedPlanId: secret.id }).expect(404)

      expect(await raw.auditLog.count({ where: { action: UPGRADE_ACTION } })).toBe(0)
    })

    it('rejects a message past the length bound', async () => {
      const { token } = await operatorWithAdmin()

      await post(`${SELF}/upgrade-request`, token, { message: 'x'.repeat(1_001) }).expect(400)
    })

    // Nothing here moves a tenant onto a plan: that stays a platform administrator's write.
    it('changes no billing state', async () => {
      const { operator, token } = await operatorWithAdmin()
      const growth = await growthPlan()

      await post(`${SELF}/upgrade-request`, token, { requestedPlanId: growth.id }).expect(200)

      expect(await raw.operatorSubscription.count({ where: { operatorId: operator.id } })).toBe(0)
      const after = await get(`${SELF}/me`, token).expect(200)
      expect(after.body.planCode).toBe('starter')
    })
  })
})
