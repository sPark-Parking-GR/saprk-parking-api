import { randomUUID } from 'node:crypto'
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
import type { SubscriptionBillingWebhookEvent } from '@spark/subscription-billing'
import request from 'supertest'
import type { PrismaService } from '../../src/prisma/prisma.service'
import { DriverSubscriptionEventsService } from '../../src/subscriptions/driver-subscription-events.service'
import { OperatorSubscriptionEventsService } from '../../src/subscriptions/operator-subscription-events.service'
import { SubscriptionAdminService } from '../../src/subscriptions/subscription-admin.service'
import { bearerToken } from '../utils/auth'
import { truncateAll } from '../utils/db'
import { seedFacility, seedOperator, seedSubscriptionPlan, seedUser } from '../utils/seed'
import { createTestApp } from '../utils/test-app'
import { resetThrottle } from '../utils/throttle'

const API = '/api/v1'
const SELF = `${API}/operator-subscriptions`
const CENTRE = { lat: 37.9838, lng: 23.7275 }

/**
 * The whole self-serve operator-billing round trip against a real database and the real mock
 * provider: catalog → checkout → the stand-in hosted page → the SAME webhook event handler a
 * Stripe delivery reaches → the operator's own view → an administrator ending it upstream.
 *
 * The unit specs prove each piece against mocks. This one proves the migration, the provider
 * wiring, the global route prefix the mock checkout URL is built from, and the admin cancel
 * path all agree once a real Postgres and a real Nest container are underneath them.
 */
describe('operator self-serve checkout (e2e)', () => {
  let app: NestFastifyApplication
  let prisma: PrismaService
  // Unextended client: reads the audit rows and the non-ACTIVE lifecycle states the extended
  // client hides, which is how the archived-plan case is set up.
  let raw: PrismaClient

  let operator: ParkingOperator
  let admin: User
  let token: string

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
    operator = await seedOperator(prisma)
    admin = await seedUser(prisma, { role: UserRole.OPERATOR_ADMIN, operatorId: operator.id })
    token = bearerToken(admin)
  })

  function get(path: string, bearer?: string) {
    const call = request(app.getHttpServer()).get(path)
    return bearer ? call.set('authorization', `Bearer ${bearer}`) : call
  }

  function post(path: string, body: object, bearer?: string) {
    const call = request(app.getHttpServer()).post(path).send(body)
    return bearer ? call.set('authorization', `Bearer ${bearer}`) : call
  }

  function growthPlan(over: Record<string, unknown> = {}) {
    return seedSubscriptionPlan(raw, {
      id: `plan_${randomUUID().replace(/-/g, '').slice(0, 10)}`,
      code: 'growth',
      name: 'Growth',
      maxFacilities: 5,
      priceCents: 4_900,
      ...over,
    })
  }

  /** The session id the mock provider embedded in the URL it handed the client. */
  function sessionIdFrom(checkoutUrl: string): string {
    const path = new URL(checkoutUrl).pathname
    expect(path.startsWith(`${SELF}/mock-checkout/`)).toBe(true)
    return path.slice(`${SELF}/mock-checkout/`.length)
  }

  async function startCheckout(planId: string): Promise<string> {
    const response = await post(`${SELF}/checkout`, { planId }, token).expect(200)
    return sessionIdFrom(response.body.checkoutUrl as string)
  }

  async function subscribeTo(planId: string): Promise<void> {
    const sessionId = await startCheckout(planId)
    await post(`${SELF}/mock-checkout/${sessionId}/confirm`, {}).expect(302)
  }

  describe('POST /operator-subscriptions/checkout', () => {
    it('refuses an anonymous caller with 401', async () => {
      const plan = await growthPlan()

      await post(`${SELF}/checkout`, { planId: plan.id }).expect(401)
    })

    it('refuses a STAFF member of the same operator, and writes no customer', async () => {
      const plan = await growthPlan()
      const staff = await seedUser(prisma, {
        role: UserRole.OPERATOR_STAFF,
        operatorId: operator.id,
        memberRole: OperatorMemberRole.STAFF,
      })

      await post(`${SELF}/checkout`, { planId: plan.id }, bearerToken(staff)).expect(403)

      expect(
        await raw.operatorBillingCustomer.count({ where: { operatorId: operator.id } }),
      ).toBe(0)
    })

    it('creates the tenant’s billing customer once and returns a mock checkout URL', async () => {
      const plan = await growthPlan()

      const response = await post(`${SELF}/checkout`, { planId: plan.id }, token).expect(200)

      expect(typeof response.body.checkoutUrl).toBe('string')
      expect(Object.keys(response.body)).toEqual(['checkoutUrl'])
      const customer = await raw.operatorBillingCustomer.findUniqueOrThrow({
        where: { operatorId: operator.id },
      })
      expect(customer.provider).toBe('mock')
      expect(customer.providerCustomerId).toMatch(/^cus_mock_/)

      // A second checkout reuses the identity rather than forking the tenant's invoices.
      await post(`${SELF}/checkout`, { planId: plan.id }, token).expect(200)
      const after = await raw.operatorBillingCustomer.findUniqueOrThrow({
        where: { operatorId: operator.id },
      })
      expect(after.providerCustomerId).toBe(customer.providerCustomerId)
    })

    it('answers 404 for an archived plan and writes no customer', async () => {
      const plan = await growthPlan()
      await raw.subscriptionPlan.update({
        where: { id: plan.id },
        data: { lifecycleStatus: LifecycleStatus.ARCHIVED },
      })

      await post(`${SELF}/checkout`, { planId: plan.id }, token).expect(404)

      expect(
        await raw.operatorBillingCustomer.count({ where: { operatorId: operator.id } }),
      ).toBe(0)
    })

    // The return URLs are built from WEB_APP_URL; nothing in the body may reach them, and
    // there is no operatorId field to smuggle another tenant in with either.
    it('rejects a body carrying anything beyond planId', async () => {
      const plan = await growthPlan()
      const other = await seedOperator(prisma)

      await post(
        `${SELF}/checkout`,
        { planId: plan.id, successUrl: 'https://evil.test/steal' },
        token,
      ).expect(400)
      await post(`${SELF}/checkout`, { planId: plan.id, operatorId: other.id }, token).expect(400)
    })

    /**
     * The guard that has no driver equivalent: an operator's entitlements cap resources they
     * have already created, so a downgrade has to be refused BEFORE the card is charged.
     */
    it('refuses a plan the tenant’s current usage would not fit, before charging', async () => {
      const tiny = await growthPlan({ code: 'tiny', name: 'Tiny', maxFacilities: 1 })
      await seedFacility(raw, { operatorId: operator.id, ...CENTRE })
      await seedFacility(raw, { operatorId: operator.id, lat: 37.99, lng: 23.73 })

      const response = await post(`${SELF}/checkout`, { planId: tiny.id }, token).expect(409)

      expect(response.body.message).toContain('facilities')
      expect(
        await raw.operatorBillingCustomer.count({ where: { operatorId: operator.id } }),
      ).toBe(0)
    })
  })

  describe('the mock checkout round trip', () => {
    it('renders a confirmable page at the URL the provider generated', async () => {
      const plan = await growthPlan()
      const sessionId = await startCheckout(plan.id)

      const page = await get(`${SELF}/mock-checkout/${sessionId}`).expect(200)

      expect(page.headers['content-type']).toContain('text/html')
      expect(page.text).toContain('growth')
      expect(page.text).toContain(`${sessionId}/confirm`)
    })

    it('flips the operator to the subscribed state and returns them to the dashboard', async () => {
      const plan = await growthPlan()
      const sessionId = await startCheckout(plan.id)

      const confirmed = await post(`${SELF}/mock-checkout/${sessionId}/confirm`, {}).expect(302)
      expect(confirmed.headers.location).toBe(
        'http://localhost:3000/dashboard/billing?checkout=success',
      )

      const me = await get(`${SELF}/me`, token).expect(200)
      expect(me.body).toMatchObject({
        planCode: 'growth',
        planName: 'Growth',
        status: SubscriptionStatus.ACTIVE,
        source: 'subscription',
        entitlements: expect.objectContaining({ maxFacilities: 5 }),
      })
      expect(typeof me.body.currentPeriodEnd).toBe('string')

      const rows = await raw.operatorSubscription.findMany({
        where: { operatorId: operator.id },
      })
      expect(rows).toHaveLength(1)
      expect(rows[0]!.providerSubscriptionId).toMatch(/^sub_mock_/)
      expect(rows[0]!.lastEventAt).toBeInstanceOf(Date)
    })

    // The event id is the replay gate, and it is what stops one purchase becoming two grants.
    it('records the billing event once, with an audit row', async () => {
      const plan = await growthPlan()
      await subscribeTo(plan.id)

      const events = await raw.webhookEvent.findMany({ where: { type: 'checkout.completed' } })
      expect(events).toHaveLength(1)
      expect(events[0]!.provider).toBe('mock')
      expect(events[0]!.outcome).toBe('processed')

      const audits = await raw.auditLog.findMany({
        where: { action: 'operator_subscription.billing_event_processed' },
      })
      expect(audits).toHaveLength(1)
    })

    it('is idempotent when the confirm form is submitted twice', async () => {
      const plan = await growthPlan()
      const sessionId = await startCheckout(plan.id)

      await post(`${SELF}/mock-checkout/${sessionId}/confirm`, {}).expect(302)
      await post(`${SELF}/mock-checkout/${sessionId}/confirm`, {}).expect(302)

      expect(
        await raw.operatorSubscription.count({ where: { operatorId: operator.id } }),
      ).toBe(1)
      expect(await raw.webhookEvent.count({ where: { type: 'checkout.completed' } })).toBe(1)
    })

    it('leaves the operator on the default plan when they abandon the page', async () => {
      const plan = await growthPlan()
      const sessionId = await startCheckout(plan.id)

      const cancelled = await post(`${SELF}/mock-checkout/${sessionId}/cancel`, {}).expect(302)
      expect(cancelled.headers.location).toBe(
        'http://localhost:3000/dashboard/billing?checkout=cancel',
      )

      const me = await get(`${SELF}/me`, token).expect(200)
      expect(me.body.source).toBe('default')
      expect(
        await raw.operatorSubscription.count({ where: { operatorId: operator.id } }),
      ).toBe(0)
    })

    it('404s an unknown session rather than rendering an empty page', async () => {
      await get(`${SELF}/mock-checkout/cs_mock_nope`).expect(404)
    })
  })

  describe('an operator who already holds a subscription', () => {
    it('is refused a duplicate checkout for the plan they are already on', async () => {
      const plan = await growthPlan()
      await subscribeTo(plan.id)

      const response = await post(`${SELF}/checkout`, { planId: plan.id }, token).expect(409)

      expect(response.body.message).toContain('growth')
      expect(
        await raw.operatorSubscription.count({ where: { operatorId: operator.id } }),
      ).toBe(1)
    })

    /**
     * A DIFFERENT plan is a genuine plan change. The old provider subscription has to be
     * cancelled when the new one activates, or it keeps charging with nothing pointing at it
     * — and the old row is retired rather than overwritten so the `subscription.deleted` that
     * cancellation provokes lands there instead of on the plan just bought.
     */
    it('cancels the superseded provider subscription when the operator changes plan', async () => {
      const growth = await growthPlan()
      const scale = await growthPlan({ code: 'scale', name: 'Scale', maxFacilities: 20 })
      await subscribeTo(growth.id)
      const first = await raw.operatorSubscription.findFirstOrThrow({
        where: { operatorId: operator.id },
      })

      await subscribeTo(scale.id)

      const rows = await raw.operatorSubscription.findMany({
        where: { operatorId: operator.id },
        orderBy: { createdAt: 'asc' },
      })
      expect(rows).toHaveLength(2)
      expect(rows[0]!.id).toBe(first.id)
      expect(rows[0]!.status).toBe(SubscriptionStatus.CANCELLED)
      expect(rows[0]!.providerSubscriptionId).toBe(first.providerSubscriptionId)
      expect(rows[1]!.status).toBe(SubscriptionStatus.ACTIVE)
      expect(rows[1]!.planId).toBe(scale.id)

      // The audit row is written only when the provider actually accepted the cancellation.
      expect(
        await raw.auditLog.count({
          where: { action: 'operator_subscription.provider_subscription_cancelled' },
        }),
      ).toBe(1)

      const me = await get(`${SELF}/me`, token).expect(200)
      expect(me.body.planCode).toBe('scale')
    })
  })

  /**
   * The out-of-order defence against a real database. The unit spec proves the comparison;
   * this proves the `lastEventAt` migration, the column Prisma actually writes, and the
   * ordering that survives a round trip through Postgres.
   *
   * Driven through the real OperatorSubscriptionEventsService rather than the HTTP webhook:
   * the route needs Fastify's raw body for signature verification, which the shared e2e app
   * deliberately does not enable, and the handler is the whole subject either way.
   */
  describe('out-of-order webhook delivery', () => {
    let events: OperatorSubscriptionEventsService

    beforeEach(() => {
      events = app.get(OperatorSubscriptionEventsService)
    })

    async function subscribe(): Promise<{ providerSubscriptionId: string }> {
      const plan = await growthPlan()
      await subscribeTo(plan.id)
      const row = await raw.operatorSubscription.findFirstOrThrow({
        where: { operatorId: operator.id },
      })
      return { providerSubscriptionId: row.providerSubscriptionId! }
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
     * The driver side's HIGH 1, end to end and with more at stake: a resurrected row hands
     * back facility, tariff-plan and staff-seat quota nobody is paying for, because
     * EntitlementService.describe reads status alone.
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

      const row = await raw.operatorSubscription.findFirstOrThrow({
        where: { operatorId: operator.id },
      })
      expect(row.status).toBe(SubscriptionStatus.CANCELLED)
      const me = await get(`${SELF}/me`, token).expect(200)
      expect(me.body.source).toBe('default')
    })

    // The general case, and the reason this is a column rather than a cancelled-specific
    // patch: an older `active` event must not undo a newer dunning state.
    it('does not revert a newer past_due when a stale active update arrives after it', async () => {
      const { providerSubscriptionId } = await subscribe()

      expect(
        await events.process(billingEvent({ providerSubscriptionId, status: 'past_due' })),
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

      const row = await raw.operatorSubscription.findFirstOrThrow({
        where: { operatorId: operator.id },
      })
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

      await events.process(billingEvent({ providerSubscriptionId, status: 'past_due' }))
      await events.process(stale)

      const recorded = await raw.webhookEvent.findUniqueOrThrow({
        where: {
          providerEventId_surface: {
            providerEventId: stale.id,
            surface: 'operator-subscription',
          },
        },
      })
      expect(recorded.outcome).toBe('stale')
      expect(
        await raw.auditLog.count({
          where: { action: 'operator_subscription.billing_event_processed' },
        }),
      ).toBe(3)
    })

    // The two engines share one provider and one WebhookEvent table. A rider's event must
    // never be applied to a tenant, whatever the operator handler is handed.
    it('ignores an event whose subscriber is a driver', async () => {
      const plan = await growthPlan()

      const outcome = await events.process(
        billingEvent({
          type: 'checkout.completed',
          subscriber: { type: 'driver', id: admin.id },
          planId: plan.id,
          providerSubscriptionId: `sub_${randomUUID()}`,
        }),
      )

      expect(outcome).toBe('not_an_operator')
      expect(
        await raw.operatorSubscription.count({ where: { operatorId: operator.id } }),
      ).toBe(0)
    })
  })

  /**
   * HIGH. Idempotency is scoped per consumer, against a real unique index.
   *
   * The driver and operator webhooks are TWO Stripe endpoints on ONE Stripe account, both
   * subscribed to checkout.session.completed and the customer.subscription.* family, and
   * Stripe cannot filter a subscription by metadata — so it delivers the SAME `evt_…` to
   * both. While WebhookEvent.providerEventId was unique table-wide, whichever endpoint
   * committed first claimed the id and the other's insert raised P2002, which its handler
   * read as "already processed" and acknowledged 200 without having applied anything.
   *
   * These run both real handlers against the real database, which is the only place the
   * compound index actually exists — the unit specs can only prove what each handler does
   * with a P2002 it is handed.
   */
  describe('idempotency is scoped per webhook surface', () => {
    let operatorEvents: OperatorSubscriptionEventsService
    let driverEvents: DriverSubscriptionEventsService

    beforeEach(() => {
      operatorEvents = app.get(OperatorSubscriptionEventsService)
      driverEvents = app.get(DriverSubscriptionEventsService)
    })

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
     * The money-losing case, exactly as reported: an operator's real purchase reaches the
     * driver endpoint first, which correctly declines it as not a rider's — but used to
     * claim the event id doing so, after which the operator endpoint 200'd the purchase as a
     * duplicate and never created the subscription the tenant had been charged for.
     */
    it('creates the operator’s subscription for an event id the driver surface already recorded', async () => {
      const plan = await growthPlan()
      const purchase = billingEvent({
        type: 'checkout.completed',
        subscriber: { type: 'operator', id: operator.id },
        planId: plan.id,
        status: 'active',
        providerSubscriptionId: `sub_${randomUUID()}`,
      })

      expect(await driverEvents.process(purchase)).toBe('not_a_driver')
      expect(await operatorEvents.process(purchase)).toBe('processed')

      const row = await raw.operatorSubscription.findFirstOrThrow({
        where: { operatorId: operator.id },
      })
      expect(row.planId).toBe(plan.id)
      expect(row.status).toBe(SubscriptionStatus.ACTIVE)
    })

    /**
     * The symmetric loss, and the one with no way back: a cancellation the driver endpoint
     * saw first left the operator's subscription ACTIVE forever, because the delivery that
     * would have ended it had already been acknowledged and would never be redelivered.
     */
    it('applies a cancellation the driver surface saw first', async () => {
      const plan = await growthPlan()
      await subscribeTo(plan.id)
      const subscribed = await raw.operatorSubscription.findFirstOrThrow({
        where: { operatorId: operator.id },
      })

      const cancellation = billingEvent({
        type: 'subscription.deleted',
        providerSubscriptionId: subscribed.providerSubscriptionId!,
        status: 'canceled',
      })

      expect(await driverEvents.process(cancellation)).toBe('unmatched_subscription')
      expect(await operatorEvents.process(cancellation)).toBe('processed')

      const row = await raw.operatorSubscription.findUniqueOrThrow({
        where: { id: subscribed.id },
      })
      expect(row.status).toBe(SubscriptionStatus.CANCELLED)
    })

    // One id, one ledger row per surface. Both handlers genuinely recorded a delivery, and
    // each can still tell its OWN replay from the other's.
    it('keeps a ledger row per surface for one event id', async () => {
      const plan = await growthPlan()
      const purchase = billingEvent({
        type: 'checkout.completed',
        subscriber: { type: 'operator', id: operator.id },
        planId: plan.id,
        status: 'active',
        providerSubscriptionId: `sub_${randomUUID()}`,
      })

      await driverEvents.process(purchase)
      await operatorEvents.process(purchase)

      const rows = await raw.webhookEvent.findMany({
        where: { providerEventId: purchase.id },
        orderBy: { surface: 'asc' },
      })
      expect(rows.map((row) => row.surface)).toEqual([
        'driver-subscription',
        'operator-subscription',
      ])
      expect(rows.map((row) => row.outcome)).toEqual(['not_a_driver', 'processed'])
    })

    // The narrowing must not cost the guarantee it started as: a surface redelivered its own
    // event is still a replay, and must still change nothing.
    it('still treats a redelivery to the SAME surface as a duplicate', async () => {
      const plan = await growthPlan()
      const purchase = billingEvent({
        type: 'checkout.completed',
        subscriber: { type: 'operator', id: operator.id },
        planId: plan.id,
        status: 'active',
        providerSubscriptionId: `sub_${randomUUID()}`,
      })

      expect(await operatorEvents.process(purchase)).toBe('processed')
      expect(await operatorEvents.process(purchase)).toBe('duplicate')

      expect(await raw.operatorSubscription.count({ where: { operatorId: operator.id } })).toBe(1)
      expect(await raw.webhookEvent.count({ where: { providerEventId: purchase.id } })).toBe(1)
    })
  })

  /**
   * The administrator's half. A DB-only cancellation is not a cancellation now that a real
   * provider subscription can exist behind an operator's plan.
   */
  describe('an administrator ending a self-serve subscription', () => {
    let admins: SubscriptionAdminService

    beforeEach(() => {
      admins = app.get(SubscriptionAdminService)
    })

    it('cancels at the billing provider and leaves the row cancelled', async () => {
      const plan = await growthPlan()
      await subscribeTo(plan.id)
      const live = await raw.operatorSubscription.findFirstOrThrow({
        where: { operatorId: operator.id },
      })
      const platformAdmin = await seedUser(prisma, { role: UserRole.PLATFORM_ADMIN })

      await admins.assignSubscription(
        {
          id: platformAdmin.id,
          email: platformAdmin.email,
          role: 'platform_admin',
          emailVerified: true,
        },
        operator.id,
        { planId: plan.id, status: SubscriptionStatus.CANCELLED, cancelAtPeriodEnd: false },
      )

      const after = await raw.operatorSubscription.findUniqueOrThrow({ where: { id: live.id } })
      expect(after.status).toBe(SubscriptionStatus.CANCELLED)

      // The mock provider throws on an unknown subscription id, so a cancellation it accepted
      // is proof the real provider call was made with the id this row was carrying.
      expect(
        await raw.auditLog.count({
          where: { action: 'operator_subscription.provider_cancel_failed' },
        }),
      ).toBe(0)
      const assigned = await raw.auditLog.findFirstOrThrow({
        where: { action: 'operator_subscription.assigned' },
      })
      expect(assigned.payload).toMatchObject({
        cancelledProviderSubscriptionId: live.providerSubscriptionId,
      })

      const me = await get(`${SELF}/me`, token).expect(200)
      expect(me.body.source).toBe('default')
    })
  })
})
