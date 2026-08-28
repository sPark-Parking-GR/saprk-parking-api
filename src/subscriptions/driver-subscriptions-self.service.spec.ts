import { BillingInterval, LifecycleStatus, Prisma, SubscriptionStatus } from '@prisma/client'
import type { AuthUser } from '@spark/types'
import {
  AlreadySubscribedToPlanError,
  SubscriptionPlanNotFoundError,
} from '../common/errors/domain.errors'
import type { PrismaService } from '../prisma/prisma.service'
import type { SubscriptionBillingService } from '../subscription-billing/subscription-billing.service'
import type { DriverEntitlementService } from './driver-entitlement.service'
import { FREE_TIER_DRIVER_ENTITLEMENTS } from './driver-entitlements.schema'
import { DriverSubscriptionsSelfService } from './driver-subscriptions-self.service'
import { LIVE_SUBSCRIPTION_STATUSES } from './subscriptions.constants'

const RIDER: AuthUser = {
  id: 'u1',
  email: 'rider@spark.gr',
  role: 'user',
  emailVerified: true,
}

const PLAN_ENTITLEMENTS = {
  bookingDiscountBps: 1_000,
  bookingFeeWaived: false,
  freeCancellations: null,
  features: [],
}

function planRow(over: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    code: 'plus',
    name: 'sPark Plus',
    description: 'Ten percent off every booking',
    priceCents: 499,
    currency: 'EUR',
    interval: BillingInterval.MONTHLY,
    entitlements: PLAN_ENTITLEMENTS,
    isPublic: true,
    sortOrder: 0,
    lifecycleStatus: LifecycleStatus.ACTIVE,
    ...over,
  }
}

function build(
  over: {
    plans?: unknown[]
    plan?: unknown
    customer?: unknown
    effective?: unknown
    subscription?: unknown
    providerName?: string
  } = {},
) {
  const prisma = {
    driverSubscriptionPlan: {
      findMany: jest.fn().mockResolvedValue(over.plans ?? [planRow()]),
      findFirst: jest.fn().mockResolvedValue('plan' in over ? over.plan : planRow()),
    },
    driverSubscription: {
      findFirst: jest.fn().mockResolvedValue(over.subscription ?? null),
    },
    driverBillingCustomer: {
      findUnique: jest.fn().mockResolvedValue(over.customer ?? null),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ providerCustomerId: 'cus_raced' }),
      create: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
    },
  }

  const entitlements = {
    resolveEffective: jest.fn().mockResolvedValue(
      over.effective ?? {
        userId: 'u1',
        entitlements: FREE_TIER_DRIVER_ENTITLEMENTS,
        source: 'free',
        planCode: null,
        planName: null,
        subscriptionId: null,
        status: null,
      },
    ),
  }

  const billing = {
    providerName: over.providerName ?? 'mock',
    getOrCreateCustomer: jest.fn().mockResolvedValue({ providerCustomerId: 'cus_new' }),
    createCheckoutSession: jest
      .fn()
      .mockResolvedValue({ checkoutSessionId: 'cs_1', checkoutUrl: 'http://api/cs_1' }),
    cancelSubscription: jest.fn(),
    cancelSubscriptionBestEffort: jest.fn().mockResolvedValue(true),
  }

  const service = new DriverSubscriptionsSelfService(
    prisma as unknown as PrismaService,
    entitlements as unknown as DriverEntitlementService,
    billing as unknown as SubscriptionBillingService,
  )

  return { service, prisma, billing, entitlements }
}

describe('DriverSubscriptionsSelfService.listPublicPlans', () => {
  // A sales-negotiated plan exists only for an administrator to assign by hand, and this
  // endpoint is unauthenticated — leaking one would advertise a price nobody may buy.
  it('asks only for public, lifecycle-active plans, in catalog order', async () => {
    const { service, prisma } = build()

    await service.listPublicPlans()

    expect(prisma.driverSubscriptionPlan.findMany.mock.calls[0]![0]).toMatchObject({
      where: { isPublic: true, lifecycleStatus: LifecycleStatus.ACTIVE },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    })
  })

  it('returns the rider-facing fields and no administration ones', async () => {
    const { service } = build()

    const [item] = await service.listPublicPlans()

    expect(item).toEqual({
      id: 'p1',
      code: 'plus',
      name: 'sPark Plus',
      description: 'Ten percent off every booking',
      priceCents: 499,
      currency: 'EUR',
      interval: BillingInterval.MONTHLY,
      entitlements: PLAN_ENTITLEMENTS,
    })
    expect(item).not.toHaveProperty('sortOrder')
    expect(item).not.toHaveProperty('subscribers')
    expect(item).not.toHaveProperty('lifecycleStatus')
  })

  // The blob crosses the Zod schema on the way out, exactly as every other read of it does.
  it('refuses to serve a plan whose stored entitlements no longer parse', async () => {
    const { service } = build({ plans: [planRow({ entitlements: { nonsense: true } })] })

    await expect(service.listPublicPlans()).rejects.toThrow()
  })
})

describe('DriverSubscriptionsSelfService.getMySubscription', () => {
  // The mobile screen is already built against this exact shape and cannot be changed.
  it('reports the free tier for a rider who has never subscribed', async () => {
    const { service } = build()

    expect(await service.getMySubscription('u1')).toEqual({
      planCode: null,
      planName: null,
      status: null,
      currentPeriodEnd: null,
      entitlements: FREE_TIER_DRIVER_ENTITLEMENTS,
      source: 'free',
    })
  })

  it('reports the live plan with an ISO period end, not a Date', async () => {
    const periodEnd = new Date('2026-09-27T00:00:00.000Z')
    const { service } = build({
      subscription: { currentPeriodEnd: periodEnd },
      effective: {
        userId: 'u1',
        entitlements: PLAN_ENTITLEMENTS,
        source: 'subscription',
        planCode: 'plus',
        planName: 'sPark Plus',
        subscriptionId: 'sub_1',
        status: SubscriptionStatus.ACTIVE,
      },
    })

    const view = await service.getMySubscription('u1')

    expect(view).toEqual({
      planCode: 'plus',
      planName: 'sPark Plus',
      status: SubscriptionStatus.ACTIVE,
      currentPeriodEnd: '2026-09-27T00:00:00.000Z',
      entitlements: PLAN_ENTITLEMENTS,
      source: 'subscription',
    })
    expect(typeof view.currentPeriodEnd).toBe('string')
  })

  // Nothing administrative may reach a rider's own view.
  it('carries no subscription id, override or provider id', async () => {
    const { service } = build({ subscription: { currentPeriodEnd: null } })

    const view = await service.getMySubscription('u1')

    expect(view).not.toHaveProperty('subscriptionId')
    expect(view).not.toHaveProperty('entitlementOverride')
    expect(view).not.toHaveProperty('providerSubscriptionId')
  })
})

describe('DriverSubscriptionsSelfService.startCheckout', () => {
  it('opens a session for a public plan and returns only the URL', async () => {
    const { service, billing } = build()

    expect(await service.startCheckout(RIDER, 'p1')).toEqual({ checkoutUrl: 'http://api/cs_1' })
    expect(billing.createCheckoutSession.mock.calls[0]![0]).toMatchObject({
      providerCustomerId: 'cus_new',
      subscriber: { type: 'driver', id: 'u1' },
      planId: 'p1',
      planCode: 'plus',
      priceCents: 499,
      currency: 'EUR',
      interval: BillingInterval.MONTHLY,
    })
  })

  /**
   * The security control. Nothing in the request body may influence where a rider is sent
   * back to after handing over a payment credential, so the URLs are constants and the plan
   * lookup is the only thing the caller's input reaches.
   */
  it('builds both return URLs server-side from the fixed mobile contract', async () => {
    const { service, billing } = build()

    await service.startCheckout(RIDER, 'p1')

    expect(billing.createCheckoutSession.mock.calls[0]![0]).toMatchObject({
      successUrl: 'spark://subscription-return?status=success',
      cancelUrl: 'spark://subscription-return?status=cancel',
    })
  })

  it('answers not-found for a plan that is missing, archived or not public', async () => {
    const { service, prisma, billing } = build({ plan: null })

    await expect(service.startCheckout(RIDER, 'p_hidden')).rejects.toBeInstanceOf(
      SubscriptionPlanNotFoundError,
    )
    expect(prisma.driverSubscriptionPlan.findFirst.mock.calls[0]![0].where).toEqual({
      id: 'p_hidden',
      lifecycleStatus: LifecycleStatus.ACTIVE,
      isPublic: true,
    })
    expect(billing.createCheckoutSession).not.toHaveBeenCalled()
  })

  it('reuses the rider’s stored customer instead of minting a second one', async () => {
    const { service, prisma, billing } = build({
      customer: { userId: 'u1', provider: 'mock', providerCustomerId: 'cus_existing' },
    })

    await service.startCheckout(RIDER, 'p1')

    expect(billing.getOrCreateCustomer).not.toHaveBeenCalled()
    expect(prisma.driverBillingCustomer.create).not.toHaveBeenCalled()
    expect(billing.createCheckoutSession.mock.calls[0]![0].providerCustomerId).toBe('cus_existing')
  })

  // A `cus_mock_…` means nothing to Stripe. Repoint rather than send a dead id upstream.
  it('mints a fresh customer when the deployment has changed providers', async () => {
    const { service, prisma, billing } = build({
      providerName: 'stripe',
      customer: { userId: 'u1', provider: 'mock', providerCustomerId: 'cus_mock_old' },
    })

    await service.startCheckout(RIDER, 'p1')

    expect(billing.getOrCreateCustomer).toHaveBeenCalled()
    expect(prisma.driverBillingCustomer.update.mock.calls[0]![0]).toMatchObject({
      where: { userId: 'u1' },
      data: { provider: 'stripe', providerCustomerId: 'cus_new' },
    })
  })

  /**
   * Two first-ever checkouts racing. The primary key on userId makes one lose; the loser must
   * re-read rather than fail the rider, because both provider calls resolved to the same
   * customer anyway.
   */
  it('re-reads instead of erroring when a concurrent first checkout wins the insert', async () => {
    const { service, prisma, billing } = build()
    prisma.driverBillingCustomer.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: '6' }),
    )

    await service.startCheckout(RIDER, 'p1')

    expect(prisma.driverBillingCustomer.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { userId: 'u1' },
    })
    expect(billing.createCheckoutSession.mock.calls[0]![0].providerCustomerId).toBe('cus_raced')
  })

  it('does not swallow a write failure that is not the uniqueness race', async () => {
    const { service, prisma } = build()
    prisma.driverBillingCustomer.create.mockRejectedValue(new Error('connection lost'))

    await expect(service.startCheckout(RIDER, 'p1')).rejects.toThrow('connection lost')
  })

  /**
   * HIGH 2. A rider holds at most one live subscription, so buying the plan they already have
   * only ever opened a SECOND provider subscription — which applyCheckoutCompleted then
   * detached from the row, leaving it billing the same card with nothing naming it here.
   */
  it('refuses a checkout for the plan the rider already holds', async () => {
    const { service, prisma, billing } = build({ subscription: { planId: 'p1' } })

    await expect(service.startCheckout(RIDER, 'p1')).rejects.toBeInstanceOf(
      AlreadySubscribedToPlanError,
    )
    expect(prisma.driverSubscription.findFirst.mock.calls[0]![0].where).toMatchObject({
      userId: 'u1',
      status: { in: [...LIVE_SUBSCRIPTION_STATUSES] },
    })
    expect(billing.createCheckoutSession).not.toHaveBeenCalled()
    expect(billing.getOrCreateCustomer).not.toHaveBeenCalled()
  })

  // A different plan is a genuine upgrade or downgrade. The old provider subscription is
  // cancelled when the new one activates, not here — a rider who abandons the payment page
  // must keep the plan they are still paying for.
  it('allows a checkout for a different plan while one is live, and cancels nothing yet', async () => {
    const { service, billing } = build({ subscription: { planId: 'p_other' } })

    await expect(service.startCheckout(RIDER, 'p1')).resolves.toEqual({
      checkoutUrl: 'http://api/cs_1',
    })
    expect(billing.cancelSubscription).not.toHaveBeenCalled()
  })

  /**
   * The double-tap defence. Stripe replays the stored response for a repeated key, so both
   * taps reach the SAME hosted session instead of opening two live ones — which would let one
   * rider pay twice for one plan.
   */
  it('sends a deterministic idempotency key derived from the rider, plan and time bucket', async () => {
    const { service, billing } = build()

    await service.startCheckout(RIDER, 'p1')
    await service.startCheckout(RIDER, 'p1')

    const [first, second] = billing.createCheckoutSession.mock.calls
    expect(first![0].idempotencyKey).toMatch(/^checkout_driver_u1_p1_\d+$/)
    expect(second![0].idempotencyKey).toBe(first![0].idempotencyKey)
  })

  it('keys per rider, so one rider’s tap cannot replay another’s session', async () => {
    const { service, billing } = build()

    await service.startCheckout(RIDER, 'p1')
    await service.startCheckout({ ...RIDER, id: 'u2' }, 'p1')

    const [first, second] = billing.createCheckoutSession.mock.calls
    expect(second![0].idempotencyKey).not.toBe(first![0].idempotencyKey)
  })
})
