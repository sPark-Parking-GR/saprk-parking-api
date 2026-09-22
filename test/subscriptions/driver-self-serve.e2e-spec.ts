import { randomUUID } from 'node:crypto'
import {
  LifecycleStatus,
  PrismaClient,
  SubscriptionStatus,
  UserRole,
  VehicleType,
} from '@prisma/client'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import type { SubscriptionBillingWebhookEvent } from '@spark/subscription-billing'
import request from 'supertest'
import type { PrismaService } from '../../src/prisma/prisma.service'
import { DriverSubscriptionEventsService } from '../../src/subscriptions/driver-subscription-events.service'
import { bearerToken } from '../utils/auth'
import { truncateAll } from '../utils/db'
import {
  seedDriverSubscriptionPlan,
  seedFacility,
  seedOperator,
  seedUser,
} from '../utils/seed'
import { createTestApp } from '../utils/test-app'
import { resetThrottle } from '../utils/throttle'

const API = '/api/v1'
const SELF = `${API}/driver-subscriptions`
const CENTRE = { lat: 37.9838, lng: 23.7275 }

/** €3.00/hour, all day, every day, priced for every vehicle type so it serves as the default. */
function tariffDraft() {
  return {
    name: `Plan ${randomUUID().slice(0, 8)}`,
    isActive: true,
    isDefault: true,
    validFrom: null,
    validTo: null,
    timezone: 'Europe/Athens',
    graceMinutes: 0,
    incrementMinutes: 60,
    vehicleTypes: [],
    tiers: [{ key: 't', fromMinute: 0, toMinute: null, unit: 'per_block', blockMinutes: 60 }],
    windows: [{ key: 'all', label: 'All', dayMask: 127, startMinute: 0, endMinute: 1440 }],
    rates: [{ tierKey: 't', windowKey: 'all', priceCents: 300, currency: 'EUR' }],
    caps: [],
  }
}

function twoHourWindow() {
  const startsAt = new Date(Date.now() + 60 * 60_000)
  const endsAt = new Date(startsAt.getTime() + 2 * 60 * 60_000)
  return { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() }
}

/**
 * The whole self-serve driver-billing round trip against a real database and the real mock
 * provider: catalog → checkout → the stand-in hosted page → the SAME webhook event handler a
 * Stripe delivery reaches → the rider's own view → a discounted price on an actual booking.
 *
 * The unit specs prove each piece against mocks. This one proves the migration, the provider
 * wiring, the global route prefix the mock checkout URL is built from, and the pricing path
 * all agree once a real Postgres and a real Nest container are underneath them.
 */
describe('driver self-serve subscriptions (e2e)', () => {
  let app: NestFastifyApplication
  let prisma: PrismaService
  let raw: PrismaClient

  let riderId: string
  let riderToken: string

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
    await resetThrottle(app)
    const rider = await seedUser(prisma)
    riderId = rider.id
    riderToken = bearerToken(rider)
  })

  function get(path: string, token?: string) {
    const call = request(app.getHttpServer()).get(path)
    return token ? call.set('authorization', `Bearer ${token}`) : call
  }

  function post(path: string, body: object, token?: string) {
    const call = request(app.getHttpServer()).post(path).send(body)
    return token ? call.set('authorization', `Bearer ${token}`) : call
  }

  function plusPlan() {
    return seedDriverSubscriptionPlan(raw, {
      code: 'plus',
      name: 'sPark Plus',
      priceCents: 499,
      bookingDiscountBps: 1_000,
    })
  }

  /** The session id the mock provider embedded in the URL it handed the client. */
  function sessionIdFrom(checkoutUrl: string): string {
    const path = new URL(checkoutUrl).pathname
    expect(path.startsWith(`${SELF}/mock-checkout/`)).toBe(true)
    return path.slice(`${SELF}/mock-checkout/`.length)
  }

  describe('GET /driver-subscriptions/plans', () => {
    it('serves the catalog to an anonymous caller — it is a pricing page', async () => {
      const plan = await plusPlan()

      const response = await get(`${SELF}/plans`).expect(200)

      expect(response.body).toHaveLength(1)
      expect(response.body[0]).toEqual({
        id: plan.id,
        code: 'plus',
        name: 'sPark Plus',
        description: null,
        priceCents: 499,
        currency: 'EUR',
        interval: 'MONTHLY',
        entitlements: {
          bookingDiscountBps: 1_000,
          bookingFeeWaived: false,
          freeCancellations: null,
          features: [],
        },
      })
    })

    it('never leaks the administration fields the admin catalog carries', async () => {
      await plusPlan()

      const response = await get(`${SELF}/plans`).expect(200)

      expect(response.body[0]).not.toHaveProperty('sortOrder')
      expect(response.body[0]).not.toHaveProperty('subscribers')
      expect(response.body[0]).not.toHaveProperty('lifecycleStatus')
    })

    it('hides sales-negotiated and archived plans', async () => {
      await plusPlan()
      await seedDriverSubscriptionPlan(raw, { code: 'enterprise', name: 'Bespoke' }).then((plan) =>
        raw.driverSubscriptionPlan.update({ where: { id: plan.id }, data: { isPublic: false } }),
      )
      await seedDriverSubscriptionPlan(raw, { code: 'retired', name: 'Retired' }).then((plan) =>
        raw.driverSubscriptionPlan.update({
          where: { id: plan.id },
          data: { lifecycleStatus: LifecycleStatus.ARCHIVED },
        }),
      )

      const response = await get(`${SELF}/plans`).expect(200)

      expect(response.body.map((p: { code: string }) => p.code)).toEqual(['plus'])
    })
  })

  describe('GET /driver-subscriptions/me', () => {
    it('refuses an anonymous caller with 401', async () => {
      await get(`${SELF}/me`).expect(401)
    })

    it('reports the free tier for a rider with no subscription row at all', async () => {
      const response = await get(`${SELF}/me`, riderToken).expect(200)

      expect(response.body).toEqual({
        planCode: null,
        planName: null,
        status: null,
        currentPeriodEnd: null,
        entitlements: {
          bookingDiscountBps: null,
          bookingFeeWaived: false,
          freeCancellations: null,
          features: [],
        },
        source: 'free',
      })
      expect(await raw.driverSubscription.count({ where: { userId: riderId } })).toBe(0)
    })
  })

  describe('POST /driver-subscriptions/checkout', () => {
    it('refuses an anonymous caller with 401', async () => {
      const plan = await plusPlan()

      await post(`${SELF}/checkout`, { planId: plan.id }).expect(401)
    })

    it('creates the rider’s billing customer once and returns a mock checkout URL', async () => {
      const plan = await plusPlan()

      const response = await post(`${SELF}/checkout`, { planId: plan.id }, riderToken).expect(200)

      expect(typeof response.body.checkoutUrl).toBe('string')
      const customer = await raw.driverBillingCustomer.findUniqueOrThrow({
        where: { userId: riderId },
      })
      expect(customer.provider).toBe('mock')
      expect(customer.providerCustomerId).toMatch(/^cus_mock_/)

      // A second checkout reuses the identity rather than forking the rider's invoice history.
      await post(`${SELF}/checkout`, { planId: plan.id }, riderToken).expect(200)
      const after = await raw.driverBillingCustomer.findUniqueOrThrow({
        where: { userId: riderId },
      })
      expect(after.providerCustomerId).toBe(customer.providerCustomerId)
    })

    it('answers 404 for an archived plan and writes no customer', async () => {
      const plan = await plusPlan()
      await raw.driverSubscriptionPlan.update({
        where: { id: plan.id },
        data: { lifecycleStatus: LifecycleStatus.ARCHIVED },
      })

      await post(`${SELF}/checkout`, { planId: plan.id }, riderToken).expect(404)

      expect(await raw.driverBillingCustomer.count({ where: { userId: riderId } })).toBe(0)
    })

    // The return URLs are constants; nothing in the body may reach them.
    it('rejects a body carrying anything beyond planId', async () => {
      const plan = await plusPlan()

      await post(
        `${SELF}/checkout`,
        { planId: plan.id, successUrl: 'https://evil.test/steal' },
        riderToken,
      ).expect(400)
    })
  })

  describe('the mock checkout round trip', () => {
    async function startCheckout(): Promise<string> {
      const plan = await plusPlan()
      const response = await post(`${SELF}/checkout`, { planId: plan.id }, riderToken).expect(200)
      return sessionIdFrom(response.body.checkoutUrl as string)
    }

    it('renders a confirmable page at the URL the provider generated', async () => {
      const sessionId = await startCheckout()

      const page = await get(`${SELF}/mock-checkout/${sessionId}`).expect(200)

      expect(page.headers['content-type']).toContain('text/html')
      expect(page.text).toContain('plus')
      expect(page.text).toContain(`${sessionId}/confirm`)
    })

    it('flips the rider to the subscribed state and returns them to the app', async () => {
      const sessionId = await startCheckout()

      const confirmed = await post(`${SELF}/mock-checkout/${sessionId}/confirm`, {}).expect(302)
      expect(confirmed.headers.location).toBe('spark://subscription-return?status=success')

      const me = await get(`${SELF}/me`, riderToken).expect(200)
      expect(me.body).toMatchObject({
        planCode: 'plus',
        planName: 'sPark Plus',
        status: SubscriptionStatus.ACTIVE,
        source: 'subscription',
        entitlements: expect.objectContaining({ bookingDiscountBps: 1_000 }),
      })
      expect(typeof me.body.currentPeriodEnd).toBe('string')

      const rows = await raw.driverSubscription.findMany({ where: { userId: riderId } })
      expect(rows).toHaveLength(1)
      expect(rows[0]!.providerSubscriptionId).toMatch(/^sub_mock_/)
    })

    // The event id is the replay gate, and it is what stops one purchase becoming two grants.
    it('records the billing event once, with an audit row', async () => {
      const sessionId = await startCheckout()
      await post(`${SELF}/mock-checkout/${sessionId}/confirm`, {}).expect(302)

      const events = await raw.webhookEvent.findMany({ where: { type: 'checkout.completed' } })
      expect(events).toHaveLength(1)
      expect(events[0]!.provider).toBe('mock')
      expect(events[0]!.outcome).toBe('processed')

      const audits = await raw.auditLog.findMany({
        where: { action: 'driver_subscription.billing_event_processed' },
      })
      expect(audits).toHaveLength(1)
    })

    // A double-submitted form must land the rider back in the app, not on a 500, and must
    // never mint a second subscription for one payment.
    it('is idempotent when the confirm form is submitted twice', async () => {
      const sessionId = await startCheckout()

      await post(`${SELF}/mock-checkout/${sessionId}/confirm`, {}).expect(302)
      await post(`${SELF}/mock-checkout/${sessionId}/confirm`, {}).expect(302)

      expect(await raw.driverSubscription.count({ where: { userId: riderId } })).toBe(1)
      expect(await raw.webhookEvent.count({ where: { type: 'checkout.completed' } })).toBe(1)
    })

    it('leaves the rider on the free tier when they abandon the page', async () => {
      const sessionId = await startCheckout()

      const cancelled = await post(`${SELF}/mock-checkout/${sessionId}/cancel`, {}).expect(302)
      expect(cancelled.headers.location).toBe('spark://subscription-return?status=cancel')

      const me = await get(`${SELF}/me`, riderToken).expect(200)
      expect(me.body.source).toBe('free')
      expect(await raw.driverSubscription.count({ where: { userId: riderId } })).toBe(0)
    })

    it('404s an unknown session rather than rendering an empty page', async () => {
      await get(`${SELF}/mock-checkout/cs_mock_nope`).expect(404)
    })
  })

  /**
   * The out-of-order defence against a real database. The unit spec proves the comparison;
   * this proves the `lastEventAt` migration, the column Prisma actually writes, and the
   * ordering that survives a round trip through Postgres.
   *
   * Driven through the real DriverSubscriptionEventsService rather than the HTTP webhook: the
   * route needs Fastify's raw body for signature verification, which the shared e2e app
   * deliberately does not enable, and the handler is the whole subject either way.
   */
  describe('out-of-order webhook delivery', () => {
    let events: DriverSubscriptionEventsService

    beforeEach(() => {
      events = app.get(DriverSubscriptionEventsService)
    })

    /** A subscribed rider, and the provider subscription id their row now carries. */
    async function subscribe(): Promise<{ providerSubscriptionId: string; planId: string }> {
      const plan = await plusPlan()
      const checkout = await post(`${SELF}/checkout`, { planId: plan.id }, riderToken).expect(200)
      await post(
        `${SELF}/mock-checkout/${sessionIdFrom(checkout.body.checkoutUrl as string)}/confirm`,
        {},
      ).expect(302)

      const row = await raw.driverSubscription.findFirstOrThrow({ where: { userId: riderId } })
      return { providerSubscriptionId: row.providerSubscriptionId!, planId: plan.id }
    }

    function billingEvent(
      over: Partial<SubscriptionBillingWebhookEvent>,
    ): SubscriptionBillingWebhookEvent {
      return {
        id: `evt_${randomUUID()}`,
        type: 'subscription.updated',
        eventCreatedAt: new Date(),
        raw: {},
        ...over,
      }
    }

    /**
     * HIGH 1, end to end. Stripe sent `updated` (active) then `deleted`; the first delivery
     * failed and was retried AFTER the second landed. The retry used to flip the row back to
     * ACTIVE, un-cancelling a rider who had stopped paying — and the rider's own view reads
     * status alone, so the discount never lapsed.
     */
    it('does not resurrect a cancelled subscription when a stale update is redelivered', async () => {
      const { providerSubscriptionId } = await subscribe()
      const staleUpdate = billingEvent({
        providerSubscriptionId,
        status: 'active',
        eventCreatedAt: new Date(Date.now() - 60_000),
        currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
      })

      expect(
        await events.process(
          billingEvent({
            type: 'subscription.deleted',
            providerSubscriptionId,
            status: 'canceled',
          }),
        ),
      ).toBe('processed')

      expect(await events.process(staleUpdate)).toBe('stale')

      const row = await raw.driverSubscription.findFirstOrThrow({ where: { userId: riderId } })
      expect(row.status).toBe(SubscriptionStatus.CANCELLED)
      const me = await get(`${SELF}/me`, riderToken).expect(200)
      expect(me.body.source).toBe('free')
    })

    // The general case, and the reason this is a column rather than a cancelled-specific
    // patch: an older `active` event must not undo a newer dunning state.
    it('does not revert a newer past_due when a stale active update arrives after it', async () => {
      const { providerSubscriptionId } = await subscribe()

      expect(
        await events.process(
          billingEvent({ providerSubscriptionId, status: 'past_due' }),
        ),
      ).toBe('processed')

      expect(
        await events.process(
          billingEvent({
            providerSubscriptionId,
            status: 'active',
            eventCreatedAt: new Date(Date.now() - 60_000),
          }),
        ),
      ).toBe('stale')

      const row = await raw.driverSubscription.findFirstOrThrow({ where: { userId: riderId } })
      expect(row.status).toBe(SubscriptionStatus.PAST_DUE)
    })

    // Dropped, but acknowledged and recorded — nothing distinguishes "ignored as stale" from
    // "never arrived" otherwise, and the provider must not be asked to redeliver it.
    it('still records the idempotency and audit rows for an event it drops', async () => {
      const { providerSubscriptionId } = await subscribe()
      const stale = billingEvent({
        providerSubscriptionId,
        status: 'active',
        eventCreatedAt: new Date(Date.now() - 60_000),
      })

      await events.process(
        billingEvent({ providerSubscriptionId, status: 'past_due' }),
      )
      await events.process(stale)

      const recorded = await raw.webhookEvent.findUniqueOrThrow({
        where: {
          providerEventId_surface: {
            providerEventId: stale.id,
            surface: 'driver-subscription',
          },
        },
      })
      expect(recorded.outcome).toBe('stale')
      expect(
        await raw.auditLog.count({
          where: { action: 'driver_subscription.billing_event_processed' },
        }),
      ).toBe(3)
    })
  })

  describe('a rider who already holds a subscription', () => {
    async function subscribeTo(planId: string): Promise<void> {
      const checkout = await post(`${SELF}/checkout`, { planId }, riderToken).expect(200)
      await post(
        `${SELF}/mock-checkout/${sessionIdFrom(checkout.body.checkoutUrl as string)}/confirm`,
        {},
      ).expect(302)
    }

    // HIGH 2. A second checkout for the plan they already hold only ever opened a SECOND
    // provider subscription billing the same card for the same thing.
    it('is refused a duplicate checkout for the plan they are already on', async () => {
      const plan = await plusPlan()
      await subscribeTo(plan.id)

      const response = await post(`${SELF}/checkout`, { planId: plan.id }, riderToken).expect(409)

      expect(response.body.message).toContain('plus')
      expect(await raw.driverSubscription.count({ where: { userId: riderId } })).toBe(1)
    })

    /**
     * A DIFFERENT plan is a genuine plan change. The old provider subscription has to be
     * cancelled when the new one activates, or it keeps charging with nothing pointing at it
     * — and the old row is retired rather than overwritten so the `subscription.deleted` that
     * cancellation provokes lands there instead of on the plan just bought.
     */
    it('cancels the superseded provider subscription when the rider changes plan', async () => {
      const plus = await plusPlan()
      const pro = await seedDriverSubscriptionPlan(raw, {
        code: 'pro',
        name: 'sPark Pro',
        priceCents: 999,
        bookingDiscountBps: 2_000,
      })
      await subscribeTo(plus.id)
      const first = await raw.driverSubscription.findFirstOrThrow({ where: { userId: riderId } })

      await subscribeTo(pro.id)

      const rows = await raw.driverSubscription.findMany({
        where: { userId: riderId },
        orderBy: { createdAt: 'asc' },
      })
      expect(rows).toHaveLength(2)
      expect(rows[0]!.id).toBe(first.id)
      expect(rows[0]!.status).toBe(SubscriptionStatus.CANCELLED)
      expect(rows[0]!.providerSubscriptionId).toBe(first.providerSubscriptionId)
      expect(rows[1]!.status).toBe(SubscriptionStatus.ACTIVE)
      expect(rows[1]!.planId).toBe(pro.id)

      // The audit row is written only when the provider actually accepted the cancellation.
      expect(
        await raw.auditLog.count({
          where: { action: 'driver_subscription.provider_subscription_cancelled' },
        }),
      ).toBe(1)

      const me = await get(`${SELF}/me`, riderToken).expect(200)
      expect(me.body.planCode).toBe('pro')
    })
  })

  describe('the perk reaches a real price', () => {
    let facilityId: string

    beforeEach(async () => {
      const operator = await seedOperator(prisma)
      const operatorAdmin = await seedUser(prisma, {
        role: UserRole.OPERATOR_ADMIN,
        operatorId: operator.id,
      })
      const facility = await seedFacility(raw, { operatorId: operator.id, ...CENTRE })
      facilityId = facility.id

      // Created through the API so the schedule, the manager assignment and the auto-default
      // promotion are all the real ones.
      await post(`${API}/tariff-plans`, tariffDraft(), bearerToken(operatorAdmin)).expect(201)
    })

    async function book(): Promise<{ amountCents: number }> {
      const { startsAt, endsAt } = twoHourWindow()
      const response = await request(app.getHttpServer())
        .post(`${API}/bookings`)
        .set('authorization', `Bearer ${riderToken}`)
        .set('idempotency-key', randomUUID())
        .send({
          facilityId,
          startsAt,
          endsAt,
          vehicleType: VehicleType.CAR,
          vehiclePlate: 'ABC1234',
          sourceChannel: 'MOBILE',
        })
        .expect(201)
      return response.body
    }

    it('charges a free-tier rider the schedule price', async () => {
      expect((await book()).amountCents).toBe(600)
    })

    it('charges a subscribed rider the discounted price', async () => {
      const plan = await plusPlan()
      const checkout = await post(`${SELF}/checkout`, { planId: plan.id }, riderToken).expect(200)
      await post(
        `${SELF}/mock-checkout/${sessionIdFrom(checkout.body.checkoutUrl as string)}/confirm`,
        {},
      ).expect(302)

      const booking = await book()

      // 2h at €3.00 = 600c, less 10%.
      expect(booking.amountCents).toBe(540)
      const row = await raw.booking.findFirstOrThrow({ where: { userId: riderId } })
      expect(row.quotedPriceCents).toBe(540)
    })

    /**
     * The preview endpoint is unauthenticated and prices a stay, not a person's stay. It must
     * keep quoting the schedule price even for a rider who is subscribed, or the two surfaces
     * would disagree for reasons no caller could see.
     */
    it('leaves the anonymous preview quote undiscounted', async () => {
      const plan = await plusPlan()
      const checkout = await post(`${SELF}/checkout`, { planId: plan.id }, riderToken).expect(200)
      await post(
        `${SELF}/mock-checkout/${sessionIdFrom(checkout.body.checkoutUrl as string)}/confirm`,
        {},
      ).expect(302)

      const { startsAt, endsAt } = twoHourWindow()
      const query = new URLSearchParams({
        startsAt,
        endsAt,
        vehicleType: VehicleType.CAR,
      })
      const preview = await get(`${API}/facilities/${facilityId}/quote?${query}`).expect(200)

      expect(preview.body.totalCents).toBe(600)
      expect(preview.body.discountCents).toBe(0)
    })
  })
})
