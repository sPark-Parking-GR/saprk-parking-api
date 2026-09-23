import { ForbiddenException } from '@nestjs/common'
import type { ConfigService } from '@nestjs/config'
import { BillingInterval, LifecycleStatus, OperatorMemberRole, Prisma } from '@prisma/client'
import { ORG_PERMISSIONS, type AuthUser, type Entitlements } from '@spark/types'
import { OperatorScopeService } from '../common/authz/operator-scope.service'
import {
  AlreadySubscribedToPlanError,
  OperatorTargetRequiredError,
  SubscriptionDowngradeBlockedError,
  SubscriptionPlanNotFoundError,
} from '../common/errors/domain.errors'
import type { NotificationsService } from '../notifications/notifications.service'
import { OperatorAccessService } from '../operators/operator-access.service'
import type { PrismaService } from '../prisma/prisma.service'
import type { SubscriptionBillingService } from '../subscription-billing/subscription-billing.service'
import type { EntitlementService } from './entitlement.service'
import { OperatorSubscriptionsSelfService } from './operator-subscriptions-self.service'
import { LIVE_SUBSCRIPTION_STATUSES } from './subscriptions.constants'

const OWN_OPERATOR = 'op-own'
const OTHER_OPERATOR = 'op-other'

const starter: Entitlements = {
  maxFacilities: 1,
  maxTariffPlans: null,
  maxStaffSeats: null,
  features: [],
  commissionBps: 0,
}

const owner: AuthUser = {
  id: 'user-owner',
  email: 'owner@biz.gr',
  role: 'operator_admin',
  emailVerified: true,
  displayName: 'Maria Owner',
}

function planRow(over: Record<string, unknown> = {}) {
  return {
    id: 'plan_growth',
    code: 'growth',
    name: 'Growth',
    description: 'Five facilities',
    priceCents: 4_900,
    currency: 'EUR',
    interval: BillingInterval.MONTHLY,
    entitlements: { ...starter, maxFacilities: 5 },
    isPublic: true,
    sortOrder: 1,
    lifecycleStatus: LifecycleStatus.ACTIVE,
    ...over,
  }
}

interface SetupOptions {
  memberRole?: OperatorMemberRole
  /** Written straight onto the membership row, however implausible — see the STAFF cases. */
  scopes?: string[]
  operatorIds?: string[]
  contactEmail?: string
  /** The operator's live subscription row, as the checkout guard reads it. */
  liveSubscription?: { planId: string } | null
  /** The stored OperatorBillingCustomer, if the tenant has ever opened checkout before. */
  customer?: { operatorId: string; provider: string; providerCustomerId: string } | null
  providerName?: string
}

/**
 * OperatorAccessService and OperatorScopeService are REAL here, over a mocked Prisma. The
 * permission boundary this suite is about lives inside scopesFor(), and a mocked assertScope
 * would assert only that the service called something.
 */
function setup(options: SetupOptions = {}) {
  const memberRole = options.memberRole ?? OperatorMemberRole.ADMIN
  const operatorIds = options.operatorIds ?? [OWN_OPERATOR]

  const prisma = {
    operatorMembership: {
      findMany: jest.fn().mockResolvedValue(operatorIds.map((operatorId) => ({ operatorId }))),
      findUnique: jest.fn().mockResolvedValue({ role: memberRole, scopes: options.scopes ?? [] }),
    },
    subscriptionPlan: {
      findMany: jest.fn().mockResolvedValue([planRow()]),
      findFirst: jest.fn().mockResolvedValue(planRow()),
    },
    operatorSubscription: {
      findFirst: jest.fn().mockResolvedValue(
        'liveSubscription' in options
          ? options.liveSubscription
          : {
              currentPeriodStart: new Date('2026-08-01T00:00:00.000Z'),
              currentPeriodEnd: new Date('2026-09-01T00:00:00.000Z'),
              trialEndsAt: null,
              cancelAtPeriodEnd: false,
            },
      ),
    },
    operatorBillingCustomer: {
      findUnique: jest.fn().mockResolvedValue(options.customer ?? null),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ providerCustomerId: 'cus_raced' }),
      create: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
    },
    parkingOperator: {
      findUnique: jest.fn().mockResolvedValue({ id: OWN_OPERATOR, name: 'Kifisia Parking' }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
  }

  const billing = {
    providerName: options.providerName ?? 'mock',
    getOrCreateCustomer: jest.fn().mockResolvedValue({ providerCustomerId: 'cus_new' }),
    createCheckoutSession: jest
      .fn()
      .mockResolvedValue({ checkoutSessionId: 'cs_1', checkoutUrl: 'http://api/cs_1' }),
    cancelSubscription: jest.fn(),
    cancelSubscriptionBestEffort: jest.fn().mockResolvedValue(true),
  }

  const entitlements = {
    assertUsageFitsEntitlements: jest.fn().mockResolvedValue(undefined),
    describe: jest.fn().mockResolvedValue({
      operatorId: OWN_OPERATOR,
      entitlements: starter,
      source: 'subscription',
      planCode: 'starter',
      planName: 'Starter',
      subscriptionId: 'sub-1',
      status: 'ACTIVE',
      usage: { facilities: 1, tariffPlans: 0, staffSeats: 2 },
    }),
  }

  const notifications = { sendOperatorUpgradeRequest: jest.fn().mockResolvedValue(true) }

  const values: Record<string, string | undefined> = {
    WEB_APP_URL: 'https://app.spark.test',
    PLATFORM_BILLING_CONTACT_EMAIL:
      'contactEmail' in options ? options.contactEmail : 'billing@spark.test',
  }
  const config = {
    get: jest.fn((key: string) => values[key]),
    getOrThrow: jest.fn((key: string) => {
      const value = values[key]
      if (!value) throw new Error(`${key} is not set`)
      return value
    }),
  }

  const scope = new OperatorScopeService(prisma as unknown as PrismaService)
  const access = new OperatorAccessService(prisma as unknown as PrismaService, scope)

  const service = new OperatorSubscriptionsSelfService(
    prisma as unknown as PrismaService,
    entitlements as unknown as EntitlementService,
    access,
    scope,
    notifications as unknown as NotificationsService,
    config as unknown as ConfigService,
    billing as unknown as SubscriptionBillingService,
  )

  return { prisma, entitlements, notifications, config, billing, service }
}

describe('OperatorSubscriptionsSelfService', () => {
  describe('the public catalog', () => {
    it('lists only active public plans, ordered as the admin catalog is', async () => {
      const { service, prisma } = setup()

      await service.listPublicPlans()

      expect(prisma.subscriptionPlan.findMany).toHaveBeenCalledWith({
        where: { lifecycleStatus: LifecycleStatus.ACTIVE, isPublic: true },
        orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      })
    })

    // sortOrder and the subscriber count are administration facts. Leaking the latter would
    // report how many tenants are on each tier to anyone who asked.
    it('returns the published terms only, with no administration fields', async () => {
      const { service } = setup()

      const [plan] = await service.listPublicPlans()

      expect(plan).toEqual({
        id: 'plan_growth',
        code: 'growth',
        name: 'Growth',
        description: 'Five facilities',
        priceCents: 4_900,
        currency: 'EUR',
        interval: BillingInterval.MONTHLY,
        entitlements: { ...starter, maxFacilities: 5 },
      })
    })

    it('parses each plan through the entitlements schema rather than trusting the blob', async () => {
      const { service, prisma } = setup()
      prisma.subscriptionPlan.findMany.mockResolvedValue([
        planRow({ entitlements: { ...starter, unknownKey: true } }),
      ])

      await expect(service.listPublicPlans()).rejects.toThrow()
    })
  })

  describe('reading my own subscription', () => {
    it('reports the plan, the source, the limits and the usage', async () => {
      const { service } = setup()

      await expect(service.getMySubscription(owner)).resolves.toEqual({
        planCode: 'starter',
        planName: 'Starter',
        status: 'ACTIVE',
        currentPeriodStart: '2026-08-01T00:00:00.000Z',
        currentPeriodEnd: '2026-09-01T00:00:00.000Z',
        trialEndsAt: null,
        cancelAtPeriodEnd: false,
        source: 'subscription',
        entitlements: starter,
        usage: { facilities: 1, tariffPlans: 0, staffSeats: 2 },
      })
    })

    it('reports a tenant with no subscription row without inventing a period', async () => {
      const { service, prisma } = setup()
      prisma.operatorSubscription.findFirst.mockResolvedValue(null)

      const view = await service.getMySubscription(owner)

      expect(view.currentPeriodStart).toBeNull()
      expect(view.currentPeriodEnd).toBeNull()
      expect(view.cancelAtPeriodEnd).toBe(false)
    })

    /**
     * The IDOR question. There is no operator id on the route, and the only one this method
     * ever touches comes from the caller's own memberships — so a caller has nothing to
     * substitute.
     */
    it('resolves the operator from the caller’s membership, never from an argument', async () => {
      const { service, entitlements, prisma } = setup()

      await service.getMySubscription(owner)

      expect(prisma.operatorMembership.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: owner.id } }),
      )
      expect(entitlements.describe).toHaveBeenCalledWith(OWN_OPERATOR)
      expect(entitlements.describe).not.toHaveBeenCalledWith(OTHER_OPERATOR)
    })

    // Two memberships means no implied tenant, and landing them in an arbitrary one would be
    // the same cross-tenant read by accident that naming an id would be on purpose.
    it('refuses a caller who belongs to several operators rather than picking one', async () => {
      const { service, entitlements } = setup({ operatorIds: [OWN_OPERATOR, OTHER_OPERATOR] })

      await expect(service.getMySubscription(owner)).rejects.toBeInstanceOf(
        OperatorTargetRequiredError,
      )
      expect(entitlements.describe).not.toHaveBeenCalled()
    })

    it('admits an ADMIN membership, which derives org:billing.view with no stored scopes', async () => {
      const { service } = setup({ memberRole: OperatorMemberRole.ADMIN, scopes: [] })

      await expect(service.getMySubscription(owner)).resolves.toBeDefined()
    })

    it('refuses a STAFF membership', async () => {
      const { service, entitlements } = setup({ memberRole: OperatorMemberRole.STAFF })

      await expect(service.getMySubscription(owner)).rejects.toBeInstanceOf(ForbiddenException)
      expect(entitlements.describe).not.toHaveBeenCalled()
    })

    /**
     * The structural half of STAFF_FORBIDDEN_SCOPES: even a row that already carries the scope
     * — written by a script, a fixture or a build that predates the exclusion — grants nothing,
     * because scopesFor() filters it out at READ time rather than trusting the write path.
     */
    it('refuses a STAFF membership that somehow stores org:billing.view', async () => {
      const { service, entitlements } = setup({
        memberRole: OperatorMemberRole.STAFF,
        scopes: [...ORG_PERMISSIONS],
      })

      await expect(service.getMySubscription(owner)).rejects.toBeInstanceOf(ForbiddenException)
      expect(entitlements.describe).not.toHaveBeenCalled()
    })
  })

  describe('starting a checkout', () => {
    it('opens a session for a public plan and returns only the URL', async () => {
      const { service, billing } = setup()

      await expect(service.startCheckout(owner, { planId: 'plan_growth' })).resolves.toEqual({
        checkoutUrl: 'http://api/cs_1',
      })
      expect(billing.createCheckoutSession.mock.calls[0]![0]).toMatchObject({
        providerCustomerId: 'cus_new',
        subscriber: { type: 'operator', id: OWN_OPERATOR },
        planId: 'plan_growth',
        planCode: 'growth',
        priceCents: 4_900,
        currency: 'EUR',
        interval: BillingInterval.MONTHLY,
      })
    })

    /**
     * The security control. Nothing in the request body may influence where an operator is
     * sent back to after handing over a payment credential, so both URLs are built from
     * WEB_APP_URL and the plan lookup is the only thing the caller's input reaches.
     */
    it('builds both return URLs server-side from WEB_APP_URL', async () => {
      const { service, billing } = setup()

      await service.startCheckout(owner, { planId: 'plan_growth' })

      expect(billing.createCheckoutSession.mock.calls[0]![0]).toMatchObject({
        successUrl: 'https://app.spark.test/dashboard/billing?checkout=success',
        cancelUrl: 'https://app.spark.test/dashboard/billing?checkout=cancel',
      })
    })

    // The operator is derived from the caller's memberships; there is no id on the route and
    // none in the body, so the subscriber the provider is told about cannot be substituted.
    it('resolves the operator from the caller’s membership, never from the body', async () => {
      const { service, prisma, billing } = setup()

      await service.startCheckout(owner, { planId: 'plan_growth' })

      expect(prisma.operatorMembership.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: owner.id } }),
      )
      expect(billing.createCheckoutSession.mock.calls[0]![0].subscriber.id).toBe(OWN_OPERATOR)
    })

    it('answers not-found for a plan that is missing, archived or not public', async () => {
      const { service, prisma, billing } = setup()
      prisma.subscriptionPlan.findFirst.mockResolvedValue(null)

      await expect(service.startCheckout(owner, { planId: 'plan_hidden' })).rejects.toBeInstanceOf(
        SubscriptionPlanNotFoundError,
      )
      expect(prisma.subscriptionPlan.findFirst).toHaveBeenCalledWith({
        where: { id: 'plan_hidden', lifecycleStatus: LifecycleStatus.ACTIVE, isPublic: true },
      })
      expect(billing.createCheckoutSession).not.toHaveBeenCalled()
    })

    /**
     * An operator holds at most one live subscription, so buying the plan they are already on
     * would only ever open a SECOND provider subscription billing the same card for the same
     * thing.
     */
    it('refuses a checkout for the plan the operator already holds', async () => {
      const { service, prisma, billing } = setup({ liveSubscription: { planId: 'plan_growth' } })

      await expect(service.startCheckout(owner, { planId: 'plan_growth' })).rejects.toBeInstanceOf(
        AlreadySubscribedToPlanError,
      )
      expect(prisma.operatorSubscription.findFirst.mock.calls[0]![0].where).toMatchObject({
        operatorId: OWN_OPERATOR,
        status: { in: [...LIVE_SUBSCRIPTION_STATUSES] },
      })
      expect(billing.createCheckoutSession).not.toHaveBeenCalled()
      expect(billing.getOrCreateCustomer).not.toHaveBeenCalled()
    })

    // A different plan is a genuine upgrade or downgrade. The old provider subscription is
    // cancelled when the new one activates, not here — an operator who abandons the payment
    // page must keep the plan they are still paying for.
    it('allows a checkout for a different plan while one is live, and cancels nothing yet', async () => {
      const { service, billing } = setup({ liveSubscription: { planId: 'plan_other' } })

      await expect(service.startCheckout(owner, { planId: 'plan_growth' })).resolves.toEqual({
        checkoutUrl: 'http://api/cs_1',
      })
      expect(billing.cancelSubscription).not.toHaveBeenCalled()
    })

    /**
     * The guard the driver path has no equivalent of. Operator entitlements cap countable
     * resources the tenant has already created, so a self-serve downgrade must be refused
     * BEFORE a card is charged — the webhook that applies the purchase is too late to say no.
     */
    it('refuses a downgrade the operator’s current usage would not fit, before charging', async () => {
      const { service, entitlements, billing } = setup()
      entitlements.assertUsageFitsEntitlements.mockRejectedValue(
        new SubscriptionDowngradeBlockedError([
          { resource: 'facilities', limit: 5, current: 7, remove: 2 },
        ]),
      )

      await expect(service.startCheckout(owner, { planId: 'plan_growth' })).rejects.toBeInstanceOf(
        SubscriptionDowngradeBlockedError,
      )
      expect(entitlements.assertUsageFitsEntitlements).toHaveBeenCalledWith(OWN_OPERATOR, {
        ...starter,
        maxFacilities: 5,
      })
      expect(billing.createCheckoutSession).not.toHaveBeenCalled()
    })

    it('reuses the tenant’s stored customer instead of minting a second one', async () => {
      const { service, prisma, billing } = setup({
        customer: { operatorId: OWN_OPERATOR, provider: 'mock', providerCustomerId: 'cus_kept' },
      })

      await service.startCheckout(owner, { planId: 'plan_growth' })

      expect(billing.getOrCreateCustomer).not.toHaveBeenCalled()
      expect(prisma.operatorBillingCustomer.create).not.toHaveBeenCalled()
      expect(billing.createCheckoutSession.mock.calls[0]![0].providerCustomerId).toBe('cus_kept')
    })

    // A `cus_mock_…` means nothing to Stripe. Repoint rather than send a dead id upstream.
    it('mints a fresh customer when the deployment has changed providers', async () => {
      const { service, prisma, billing } = setup({
        providerName: 'stripe',
        customer: { operatorId: OWN_OPERATOR, provider: 'mock', providerCustomerId: 'cus_old' },
      })

      await service.startCheckout(owner, { planId: 'plan_growth' })

      expect(billing.getOrCreateCustomer).toHaveBeenCalled()
      expect(prisma.operatorBillingCustomer.update.mock.calls[0]![0]).toMatchObject({
        where: { operatorId: OWN_OPERATOR },
        data: { provider: 'stripe', providerCustomerId: 'cus_new' },
      })
    })

    // The provider needs a contact address and an operator has none of its own, so the acting
    // administrator's is what the receipts go to. The row it keys is still the tenant's.
    it('registers the acting administrator’s address against the tenant’s customer', async () => {
      const { service, billing, prisma } = setup()

      await service.startCheckout(owner, { planId: 'plan_growth' })

      expect(billing.getOrCreateCustomer).toHaveBeenCalledWith({
        subscriber: { type: 'operator', id: OWN_OPERATOR },
        email: owner.email,
      })
      expect(prisma.operatorBillingCustomer.create.mock.calls[0]![0].data).toMatchObject({
        operatorId: OWN_OPERATOR,
      })
    })

    /**
     * Two admins of one operator clicking upgrade at the same moment. The primary key on
     * operatorId makes one lose; the loser must re-read rather than fail, because both
     * provider calls resolved to the same customer anyway.
     */
    it('re-reads instead of erroring when a concurrent first checkout wins the insert', async () => {
      const { service, prisma, billing } = setup()
      prisma.operatorBillingCustomer.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: '6' }),
      )

      await service.startCheckout(owner, { planId: 'plan_growth' })

      expect(prisma.operatorBillingCustomer.findUniqueOrThrow).toHaveBeenCalledWith({
        where: { operatorId: OWN_OPERATOR },
      })
      expect(billing.createCheckoutSession.mock.calls[0]![0].providerCustomerId).toBe('cus_raced')
    })

    it('does not swallow a write failure that is not the uniqueness race', async () => {
      const { service, prisma } = setup()
      prisma.operatorBillingCustomer.create.mockRejectedValue(new Error('connection lost'))

      await expect(service.startCheckout(owner, { planId: 'plan_growth' })).rejects.toThrow(
        'connection lost',
      )
    })

    /**
     * The double-click defence. Stripe replays the stored response for a repeated key, so both
     * clicks reach the SAME hosted session instead of opening two live ones — which would let
     * one tenant pay twice for one plan.
     */
    it('sends a deterministic idempotency key derived from the operator, plan and time bucket', async () => {
      const { service, billing } = setup()

      await service.startCheckout(owner, { planId: 'plan_growth' })
      await service.startCheckout(owner, { planId: 'plan_growth' })

      const [first, second] = billing.createCheckoutSession.mock.calls
      expect(first![0].idempotencyKey).toMatch(/^checkout_operator_op-own_plan_growth_\d+$/)
      expect(second![0].idempotencyKey).toBe(first![0].idempotencyKey)
    })

    // Keyed on the tenant, not the admin who clicked: two admins of one operator upgrading at
    // once must replay one session rather than open two subscriptions for one business.
    it('keys the session on the operator rather than on the acting administrator', async () => {
      const { service, billing } = setup()

      await service.startCheckout(owner, { planId: 'plan_growth' })
      await service.startCheckout({ ...owner, id: 'user-second-admin' }, { planId: 'plan_growth' })

      const [first, second] = billing.createCheckoutSession.mock.calls
      expect(second![0].idempotencyKey).toBe(first![0].idempotencyKey)
    })

    it('refuses a STAFF membership before reaching the provider', async () => {
      const { service, billing } = setup({
        memberRole: OperatorMemberRole.STAFF,
        scopes: [...ORG_PERMISSIONS],
      })

      await expect(service.startCheckout(owner, { planId: 'plan_growth' })).rejects.toBeInstanceOf(
        ForbiddenException,
      )
      expect(billing.getOrCreateCustomer).not.toHaveBeenCalled()
      expect(billing.createCheckoutSession).not.toHaveBeenCalled()
    })

    it('refuses a caller who belongs to several operators rather than picking one', async () => {
      const { service, billing } = setup({ operatorIds: [OWN_OPERATOR, OTHER_OPERATOR] })

      await expect(service.startCheckout(owner, { planId: 'plan_growth' })).rejects.toBeInstanceOf(
        OperatorTargetRequiredError,
      )
      expect(billing.createCheckoutSession).not.toHaveBeenCalled()
    })
  })

  describe('requesting an upgrade', () => {
    it('records the request against the operator, naming the plan and the message', async () => {
      const { service, prisma } = setup()

      await expect(
        service.requestUpgrade(owner, { requestedPlanId: 'plan_growth', message: 'We need five' }),
      ).resolves.toEqual({ requestId: 'audit-1', delivered: true })

      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: {
          actorId: owner.id,
          actorRole: owner.role,
          action: 'operator_subscription.upgrade_requested',
          entityType: 'ParkingOperator',
          entityId: OWN_OPERATOR,
          payload: {
            requestedPlanId: 'plan_growth',
            requestedPlanCode: 'growth',
            message: 'We need five',
          },
        },
        select: { id: true },
      })
    })

    // "Call me" is a real request. Forcing a plan id would make the operator pick a tier they
    // have not chosen just to reach a human.
    it('accepts a request that names neither a plan nor a message', async () => {
      const { service, prisma, notifications } = setup()

      await service.requestUpgrade(owner, {})

      expect(prisma.subscriptionPlan.findFirst).not.toHaveBeenCalled()
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ payload: {} }) }),
      )
      expect(notifications.sendOperatorUpgradeRequest).toHaveBeenCalledWith(
        expect.objectContaining({ requestedPlanName: null, message: null }),
      )
    })

    it('mails the platform contact with the requester and a link to the operator', async () => {
      const { service, notifications } = setup()

      await service.requestUpgrade(owner, { requestedPlanId: 'plan_growth' })

      expect(notifications.sendOperatorUpgradeRequest).toHaveBeenCalledWith({
        to: 'billing@spark.test',
        operatorName: 'Kifisia Parking',
        requesterName: 'Maria Owner',
        requesterEmail: owner.email,
        requestedPlanName: 'Growth',
        message: null,
        operatorUrl: `https://app.spark.test/admin/operators/${OWN_OPERATOR}`,
      })
    })

    it('falls back to the requester’s address when they have no display name', async () => {
      const { service, notifications } = setup()

      await service.requestUpgrade({ ...owner, displayName: undefined }, {})

      expect(notifications.sendOperatorUpgradeRequest).toHaveBeenCalledWith(
        expect.objectContaining({ requesterName: owner.email }),
      )
    })

    it('rejects a plan that is missing, archived or not public, and records nothing', async () => {
      const { service, prisma, notifications } = setup()
      prisma.subscriptionPlan.findFirst.mockResolvedValue(null)

      await expect(
        service.requestUpgrade(owner, { requestedPlanId: 'plan_ghost' }),
      ).rejects.toBeInstanceOf(SubscriptionPlanNotFoundError)

      expect(prisma.subscriptionPlan.findFirst).toHaveBeenCalledWith({
        where: { id: 'plan_ghost', lifecycleStatus: LifecycleStatus.ACTIVE, isPublic: true },
      })
      expect(prisma.auditLog.create).not.toHaveBeenCalled()
      expect(notifications.sendOperatorUpgradeRequest).not.toHaveBeenCalled()
    })

    // The record is the durable half. A missing contact address must cost the email and
    // nothing else, and the caller has to be able to tell the difference.
    it('still records the request when no platform contact is configured', async () => {
      const { service, prisma, notifications } = setup({ contactEmail: undefined })

      await expect(service.requestUpgrade(owner, {})).resolves.toEqual({
        requestId: 'audit-1',
        delivered: false,
      })
      expect(prisma.auditLog.create).toHaveBeenCalled()
      expect(notifications.sendOperatorUpgradeRequest).not.toHaveBeenCalled()
    })

    it('reports a failed delivery rather than claiming the request was sent', async () => {
      const { service, notifications } = setup()
      notifications.sendOperatorUpgradeRequest.mockResolvedValue(false)

      await expect(service.requestUpgrade(owner, {})).resolves.toEqual({
        requestId: 'audit-1',
        delivered: false,
      })
    })

    it('refuses a STAFF membership before writing or mailing anything', async () => {
      const { service, prisma, notifications } = setup({
        memberRole: OperatorMemberRole.STAFF,
        scopes: [...ORG_PERMISSIONS],
      })

      await expect(service.requestUpgrade(owner, {})).rejects.toBeInstanceOf(ForbiddenException)
      expect(prisma.auditLog.create).not.toHaveBeenCalled()
      expect(notifications.sendOperatorUpgradeRequest).not.toHaveBeenCalled()
    })

    it('files the request against the caller’s own operator and no other', async () => {
      const { service, prisma } = setup()

      await service.requestUpgrade(owner, {})

      expect(prisma.parkingOperator.findUnique).toHaveBeenCalledWith({
        where: { id: OWN_OPERATOR },
        select: { id: true, name: true },
      })
      expect(prisma.operatorMembership.findUnique).toHaveBeenCalledWith({
        where: { operatorId_userId: { operatorId: OWN_OPERATOR, userId: owner.id } },
        select: { role: true, scopes: true },
      })
    })
  })
})
