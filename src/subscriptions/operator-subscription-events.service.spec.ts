import { LifecycleStatus, Prisma, SubscriptionStatus } from '@prisma/client'
import type { SubscriptionBillingWebhookEvent } from '@spark/subscription-billing'
import type { PrismaService } from '../prisma/prisma.service'
import type { SubscriptionBillingService } from '../subscription-billing/subscription-billing.service'
import { OperatorSubscriptionEventsService } from './operator-subscription-events.service'

interface Tables {
  webhookEvent: { create: jest.Mock; update: jest.Mock }
  auditLog: { create: jest.Mock }
  operatorSubscription: {
    findUnique: jest.Mock
    findFirst: jest.Mock
    create: jest.Mock
    update: jest.Mock
  }
  subscriptionPlan: { findFirst: jest.Mock }
  operatorBillingCustomer: { findUnique: jest.Mock }
  $executeRaw: jest.Mock
}

function tables(): Tables {
  return {
    webhookEvent: { create: jest.fn(), update: jest.fn() },
    auditLog: { create: jest.fn() },
    operatorSubscription: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }: { data: object }) => ({ id: 'sub_new', ...data })),
      update: jest.fn(async () => ({ id: 'sub_existing' })),
    },
    subscriptionPlan: { findFirst: jest.fn().mockResolvedValue({ id: 'p1', code: 'growth' }) },
    operatorBillingCustomer: { findUnique: jest.fn().mockResolvedValue(null) },
    $executeRaw: jest.fn(),
  }
}

function build(tx: Tables) {
  const prisma = {
    $transaction: jest.fn(async (cb: (t: Tables) => unknown) => cb(tx)),
    auditLog: { create: jest.fn() },
  } as unknown as PrismaService

  const billing = {
    providerName: 'mock',
    cancelSubscriptionBestEffort: jest.fn().mockResolvedValue(true),
  } as unknown as SubscriptionBillingService

  return { service: new OperatorSubscriptionEventsService(prisma, billing), prisma, billing }
}

/** The overwhelming majority of these assert on outcomes alone; keep the call site short. */
function service(tx: Tables) {
  return build(tx).service
}

const NOW = new Date('2026-08-28T12:00:00Z')
const EARLIER = new Date('2026-08-28T11:00:00Z')
const LATER = new Date('2026-08-28T13:00:00Z')

function event(
  over: Partial<SubscriptionBillingWebhookEvent> = {},
): SubscriptionBillingWebhookEvent {
  return {
    id: 'evt_1',
    type: 'checkout.completed',
    eventCreatedAt: NOW,
    providerCustomerId: 'cus_1',
    providerSubscriptionId: 'sub_1',
    status: 'active',
    subscriber: { type: 'operator', id: 'op1' },
    planId: 'p1',
    raw: { ok: true },
    ...over,
  }
}

/** What Prisma reports on PostgreSQL: the field names of the constraint that fired. */
function uniqueViolation(...target: string[]) {
  return new Prisma.PrismaClientKnownRequestError('unique', {
    code: 'P2002',
    clientVersion: '6',
    meta: { target },
  })
}

/** The replay gate as PostgreSQL reports it: BOTH halves of the compound key. */
const P2002 = uniqueViolation('providerEventId', 'surface')

describe('OperatorSubscriptionEventsService — checkout.completed', () => {
  it('creates the operator’s first subscription and records the provider ids', async () => {
    const tx = tables()
    const periodEnd = new Date('2026-09-28T00:00:00Z')

    const outcome = await service(tx).process(event({ currentPeriodEnd: periodEnd }))

    expect(outcome).toBe('processed')
    expect(tx.operatorSubscription.create).toHaveBeenCalledTimes(1)
    expect(tx.operatorSubscription.create.mock.calls[0]![0].data).toMatchObject({
      operatorId: 'op1',
      planId: 'p1',
      status: SubscriptionStatus.ACTIVE,
      currentPeriodEnd: periodEnd,
      providerSubscriptionId: 'sub_1',
    })
  })

  // OperatorSubscription_operator_live_key permits one non-CANCELLED row per operator, so an
  // upgrade has to move the existing agreement rather than open a second one.
  it('moves an existing live subscription instead of creating a second row', async () => {
    const tx = tables()
    tx.operatorSubscription.findFirst.mockResolvedValue({ id: 'sub_existing' })

    const outcome = await service(tx).process(event({ planId: 'p1' }))

    expect(outcome).toBe('processed')
    expect(tx.operatorSubscription.create).not.toHaveBeenCalled()
    expect(tx.operatorSubscription.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'sub_existing' } }),
    )
  })

  // Stripe's checkout.session.completed frequently omits it; the subscription event that
  // follows supplies it. Writing null here would erase a period end a later delivery set.
  it('leaves currentPeriodEnd untouched when the event does not carry one', async () => {
    const tx = tables()

    await service(tx).process(event({ currentPeriodEnd: undefined }))

    expect(tx.operatorSubscription.create.mock.calls[0]![0].data).not.toHaveProperty(
      'currentPeriodEnd',
    )
  })

  // The same ParkingOperator lock SubscriptionAdminService.assign and FacilitiesService.create
  // take: a purchase landing between a facility create reading the quota and writing the row
  // must serialise, not race.
  it('serialises against the admin and facility paths on the ParkingOperator row lock', async () => {
    const tx = tables()

    await service(tx).process(event())

    expect(tx.$executeRaw).toHaveBeenCalledTimes(1)
  })

  it('ignores a checkout for a subscriber that is not an operator', async () => {
    const tx = tables()

    const outcome = await service(tx).process(event({ subscriber: { type: 'driver', id: 'u1' } }))

    expect(outcome).toBe('not_an_operator')
    expect(tx.operatorSubscription.create).not.toHaveBeenCalled()
  })

  // The operator has been charged for something this database cannot honour. Never invent a
  // plan: record it and leave the money for a human to reconcile.
  it('refuses to guess when the event names an unknown or archived plan', async () => {
    const tx = tables()
    tx.subscriptionPlan.findFirst.mockResolvedValue(null)

    const outcome = await service(tx).process(event())

    expect(outcome).toBe('unmatched_plan')
    expect(tx.operatorSubscription.create).not.toHaveBeenCalled()
    expect(tx.subscriptionPlan.findFirst.mock.calls[0]![0].where).toMatchObject({
      lifecycleStatus: LifecycleStatus.ACTIVE,
    })
  })

  it('does not apply the same purchase twice when it arrives under a new event id', async () => {
    const tx = tables()
    tx.operatorSubscription.findUnique.mockResolvedValue({ id: 'sub_existing' })

    const outcome = await service(tx).process(event({ id: 'evt_resent' }))

    expect(outcome).toBe('already_applied')
    expect(tx.operatorSubscription.create).not.toHaveBeenCalled()
    expect(tx.operatorSubscription.update).not.toHaveBeenCalled()
  })

  // Nothing to compare against on a purchase; this event is the row's whole history, and the
  // mark it sets is what every later delivery is ordered against.
  it('stamps the purchase event’s own timestamp as the ordering high-water mark', async () => {
    const tx = tables()

    await service(tx).process(event())

    expect(tx.operatorSubscription.create.mock.calls[0]![0].data).toMatchObject({
      lastEventAt: NOW,
    })
  })

  /**
   * The driver side's HIGH 2, on the operator surface. A tenant changing plans buys a SECOND
   * provider subscription, and the provider has no way to know it replaces the first.
   * Overwriting providerSubscriptionId in place would orphan the old one — still billing the
   * card, no longer named anywhere here.
   */
  it('cancels the superseded provider subscription when an operator changes plans', async () => {
    const tx = tables()
    tx.operatorSubscription.findFirst.mockResolvedValue({
      id: 'sub_existing',
      providerSubscriptionId: 'sub_old',
    })
    const { service: events, billing } = build(tx)

    const outcome = await events.process(event({ providerSubscriptionId: 'sub_new' }))

    expect(outcome).toBe('processed')
    expect(billing.cancelSubscriptionBestEffort).toHaveBeenCalledWith(
      'sub_old',
      expect.objectContaining({ reason: 'superseded_by_checkout' }),
    )
  })

  // Retired as its own CANCELLED row rather than overwritten, so the subscription.deleted our
  // own cancellation provokes lands here and stops instead of reaching the new plan.
  it('retires the old agreement as a cancelled row and opens a new one', async () => {
    const tx = tables()
    tx.operatorSubscription.findFirst.mockResolvedValue({
      id: 'sub_existing',
      providerSubscriptionId: 'sub_old',
    })

    await service(tx).process(event({ providerSubscriptionId: 'sub_new' }))

    expect(tx.operatorSubscription.update.mock.calls[0]![0]).toMatchObject({
      where: { id: 'sub_existing' },
      data: { status: SubscriptionStatus.CANCELLED },
    })
    expect(tx.operatorSubscription.create.mock.calls[0]![0].data).toMatchObject({
      providerSubscriptionId: 'sub_new',
    })
  })

  // An administrator's manual assignment carries no provider subscription, so there is
  // nothing upstream to cancel and the existing row is simply moved onto the purchased plan.
  it('cancels nothing when the row it moves was never billed by the provider', async () => {
    const tx = tables()
    tx.operatorSubscription.findFirst.mockResolvedValue({
      id: 'sub_existing',
      providerSubscriptionId: null,
    })
    const { service: events, billing } = build(tx)

    await events.process(event({ providerSubscriptionId: 'sub_new' }))

    expect(billing.cancelSubscriptionBestEffort).not.toHaveBeenCalled()
    expect(tx.operatorSubscription.create).not.toHaveBeenCalled()
  })

  /**
   * The webhook applies what was paid for and never runs the downgrade guard. By the time it
   * runs the card has been charged, so refusing the write would leave the tenant paying for a
   * plan this database never granted — the guard belongs in startCheckout, where it can still
   * say no for free.
   */
  it('applies a purchase without consulting the quota guard', async () => {
    const tx = tables()
    tx.operatorSubscription.findFirst.mockResolvedValue(null)

    expect(await service(tx).process(event())).toBe('processed')
  })
})

describe('OperatorSubscriptionEventsService — redelivery', () => {
  // The (providerEventId, surface) insert is the gate, and it runs BEFORE any state is
  // touched, so a redelivered purchase cannot mint a second subscription.
  it('acknowledges a redelivered event as a duplicate without touching state', async () => {
    const tx = tables()
    tx.webhookEvent.create.mockRejectedValue(P2002)

    const outcome = await service(tx).process(event())

    expect(outcome).toBe('duplicate')
    expect(tx.operatorSubscription.create).not.toHaveBeenCalled()
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })

  it('records the event id, provider and outcome for every delivery it does process', async () => {
    const tx = tables()

    await service(tx).process(event())

    expect(tx.webhookEvent.create.mock.calls[0]![0].data).toMatchObject({
      providerEventId: 'evt_1',
      surface: 'operator-subscription',
      provider: 'mock',
      type: 'checkout.completed',
    })
    expect(tx.webhookEvent.update.mock.calls[0]![0].where).toEqual({
      providerEventId_surface: { providerEventId: 'evt_1', surface: 'operator-subscription' },
    })
    expect(tx.auditLog.create.mock.calls[0]![0].data).toMatchObject({
      action: 'operator_subscription.billing_event_processed',
      entityType: 'OperatorSubscription',
      payload: { providerEventId: 'evt_1', type: 'checkout.completed', outcome: 'processed' },
    })
  })

  it('rethrows a failure that is not the replay gate', async () => {
    const tx = tables()
    tx.webhookEvent.create.mockRejectedValue(new Error('connection lost'))

    await expect(service(tx).process(event())).rejects.toThrow('connection lost')
  })

  /**
   * The same transaction writes OperatorSubscription, whose providerSubscriptionId unique and
   * one-live-row-per-operator partial index raise P2002 of their own. Reading either as
   * "already processed" would answer 200 to a genuine unhandled failure, so the provider never
   * retries and the event is lost permanently.
   */
  it.each([
    ['the provider subscription id', 'providerSubscriptionId'],
    ['the one-live-subscription-per-operator index', 'operatorId'],
  ])('propagates a uniqueness failure on %s instead of calling it a replay', async (_l, field) => {
    const tx = tables()
    tx.operatorSubscription.create.mockRejectedValue(uniqueViolation(field))

    await expect(service(tx).process(event())).rejects.toBeInstanceOf(
      Prisma.PrismaClientKnownRequestError,
    )
  })

  // Some Prisma versions report the constraint name rather than the field list; both readings
  // have to reach the same answer or a real replay would 500 forever.
  it('recognises the replay gate when Prisma names the constraint instead of the field', async () => {
    const tx = tables()
    tx.webhookEvent.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: '6',
        meta: { target: 'WebhookEvent_providerEventId_surface_key' },
      }),
    )

    expect(await service(tx).process(event())).toBe('duplicate')
  })

  /**
   * HIGH, and the bug this surface column exists for. Stripe fans one event id out to every
   * endpoint subscribed to its type, and the driver route is subscribed to all four of ours.
   * Under the retired table-wide unique, the driver route no-opping an operator's checkout as
   * "not a driver event" still claimed the id — and a P2002 naming providerEventId alone made
   * THIS handler acknowledge a purchase it never applied, leaving the tenant charged with no
   * subscription. It is not the gate any more, so it propagates.
   */
  it('does not accept a P2002 on providerEventId alone as its replay gate', async () => {
    const tx = tables()
    tx.webhookEvent.create.mockRejectedValue(uniqueViolation('providerEventId'))

    await expect(service(tx).process(event())).rejects.toBeInstanceOf(
      Prisma.PrismaClientKnownRequestError,
    )
  })

  // Files the row under its own surface, which is the whole of the fix: the driver handler
  // writes the same event id under a different one and neither collides.
  it('scopes its ledger row to the operator surface', async () => {
    const tx = tables()

    await service(tx).process(event())

    expect(tx.webhookEvent.create.mock.calls[0]![0].data).toMatchObject({
      surface: 'operator-subscription',
    })
  })
})

describe('OperatorSubscriptionEventsService — subscription.updated', () => {
  const updated = (over: Partial<SubscriptionBillingWebhookEvent> = {}) =>
    event({ type: 'subscription.updated', subscriber: undefined, planId: undefined, ...over })

  it('syncs status and period end on the row the provider id resolves', async () => {
    const tx = tables()
    const periodEnd = new Date('2026-10-28T00:00:00Z')
    tx.operatorSubscription.findUnique.mockResolvedValue({
      id: 'sub_existing',
      status: SubscriptionStatus.ACTIVE,
      providerSubscriptionId: 'sub_1',
      lastEventAt: null,
    })

    const outcome = await service(tx).process(
      updated({ status: 'trialing', currentPeriodEnd: periodEnd }),
    )

    expect(outcome).toBe('processed')
    expect(tx.operatorSubscription.update.mock.calls[0]![0].data).toMatchObject({
      status: SubscriptionStatus.TRIALING,
      currentPeriodEnd: periodEnd,
    })
  })

  /**
   * The reason the customer fallback exists: checkout.completed can land without the
   * subscription expanded, so the row that needs the period end has no provider id yet.
   */
  it('falls back to the operator behind providerCustomerId, then adopts the provider id', async () => {
    const tx = tables()
    tx.operatorSubscription.findUnique.mockResolvedValue(null)
    tx.operatorBillingCustomer.findUnique.mockResolvedValue({ operatorId: 'op1' })
    tx.operatorSubscription.findFirst.mockResolvedValue({
      id: 'sub_existing',
      status: SubscriptionStatus.ACTIVE,
      providerSubscriptionId: null,
      lastEventAt: null,
    })

    const outcome = await service(tx).process(updated({ currentPeriodEnd: new Date() }))

    expect(outcome).toBe('processed')
    expect(tx.operatorBillingCustomer.findUnique.mock.calls[0]![0].where).toEqual({
      provider_providerCustomerId: { provider: 'mock', providerCustomerId: 'cus_1' },
    })
    expect(tx.operatorSubscription.update.mock.calls[0]![0].data).toMatchObject({
      providerSubscriptionId: 'sub_1',
    })
  })

  // Logged and acknowledged, never thrown: a 5xx makes Stripe redeliver forever and
  // eventually disable the endpoint, taking the events that DO matter with it.
  it('acknowledges an event that resolves no subscription at all', async () => {
    const tx = tables()

    const outcome = await service(tx).process(updated())

    expect(outcome).toBe('unmatched_subscription')
    expect(tx.operatorSubscription.update).not.toHaveBeenCalled()
    expect(tx.auditLog.create.mock.calls[0]![0].data.payload).toMatchObject({
      outcome: 'unmatched_subscription',
    })
  })

  // Defaulting an unmodelled provider status to ACTIVE would reinstate a tenant Stripe paused.
  it('changes nothing when the event carries neither a modelled status nor a period', async () => {
    const tx = tables()
    tx.operatorSubscription.findUnique.mockResolvedValue({
      id: 'sub_existing',
      status: SubscriptionStatus.ACTIVE,
      providerSubscriptionId: 'sub_1',
      lastEventAt: null,
    })

    const outcome = await service(tx).process(
      updated({ status: undefined, currentPeriodEnd: undefined }),
    )

    expect(outcome).toBe('stale')
    expect(tx.operatorSubscription.update).not.toHaveBeenCalled()
  })

  /**
   * The driver side's HIGH 1, on the operator surface — and the stakes are higher here.
   * Stripe sent `updated` (active) then `deleted`; the first delivery failed and was retried
   * AFTER the second landed. Without the terminal guard the retry flips the row back to
   * ACTIVE, and EntitlementService.describe reads status alone — so a cancelled tenant keeps
   * facility, tariff-plan and staff-seat quota nobody is paying for.
   */
  it('never revives a cancelled subscription when a stale update is redelivered', async () => {
    const tx = tables()
    tx.operatorSubscription.findUnique.mockResolvedValue({
      id: 'sub_existing',
      status: SubscriptionStatus.CANCELLED,
      providerSubscriptionId: 'sub_1',
      lastEventAt: null,
    })

    const outcome = await service(tx).process(
      updated({ status: 'active', currentPeriodEnd: new Date('2026-12-01T00:00:00Z') }),
    )

    expect(outcome).toBe('stale')
    expect(tx.operatorSubscription.update).not.toHaveBeenCalled()
  })

  it('moves the ordering high-water mark forward on every update it applies', async () => {
    const tx = tables()
    tx.operatorSubscription.findUnique.mockResolvedValue({
      id: 'sub_existing',
      status: SubscriptionStatus.ACTIVE,
      providerSubscriptionId: 'sub_1',
      lastEventAt: EARLIER,
    })

    await service(tx).process(updated({ eventCreatedAt: LATER, status: 'past_due' }))

    expect(tx.operatorSubscription.update.mock.calls[0]![0].data).toMatchObject({
      lastEventAt: LATER,
    })
  })
})

/**
 * The general ordering defence, which is not specific to cancellation. Webhooks are not
 * ordered: a delivery that fails is retried behind the ones that overtook it, so ANY older
 * event can overwrite newer state — a stale status, or a stale period end that would roll a
 * paying tenant's access back a whole cycle.
 */
describe('OperatorSubscriptionEventsService — out-of-order delivery', () => {
  function live(over: Record<string, unknown> = {}) {
    return {
      id: 'sub_existing',
      status: SubscriptionStatus.ACTIVE,
      providerSubscriptionId: 'sub_1',
      lastEventAt: NOW,
      ...over,
    }
  }

  it('does not revert a newer past_due when a stale active update arrives after it', async () => {
    const tx = tables()
    tx.operatorSubscription.findUnique.mockResolvedValue(
      live({ status: SubscriptionStatus.PAST_DUE }),
    )

    const outcome = await service(tx).process(
      event({ type: 'subscription.updated', eventCreatedAt: EARLIER, status: 'active' }),
    )

    expect(outcome).toBe('stale')
    expect(tx.operatorSubscription.update).not.toHaveBeenCalled()
  })

  // The reason this is a column and not a cancelled-specific patch: an old `active` event
  // carrying last cycle's period end would take a month off a tenant who has already renewed.
  it('does not roll a renewed period end back to an older one', async () => {
    const tx = tables()
    tx.operatorSubscription.findUnique.mockResolvedValue(live())

    const outcome = await service(tx).process(
      event({
        type: 'subscription.updated',
        eventCreatedAt: EARLIER,
        status: 'active',
        currentPeriodEnd: new Date('2026-09-01T00:00:00Z'),
      }),
    )

    expect(outcome).toBe('stale')
    expect(tx.operatorSubscription.update).not.toHaveBeenCalled()
  })

  it.each([
    ['subscription.deleted' as const, 'canceled' as const],
    ['invoice.payment_failed' as const, 'past_due' as const],
  ])('drops a stale %s the same way', async (type, status) => {
    const tx = tables()
    tx.operatorSubscription.findUnique.mockResolvedValue(live())

    const outcome = await service(tx).process(event({ type, status, eventCreatedAt: EARLIER }))

    expect(outcome).toBe('stale')
    expect(tx.operatorSubscription.update).not.toHaveBeenCalled()
  })

  /**
   * Dropped, but still acknowledged and still recorded. A 5xx would make the provider
   * redeliver an event we have deliberately decided to ignore, and skipping the WebhookEvent
   * row would leave nothing distinguishing "dropped as stale" from "never arrived".
   */
  it('still writes the idempotency and audit rows for an event it drops', async () => {
    const tx = tables()
    tx.operatorSubscription.findUnique.mockResolvedValue(live())

    await service(tx).process(
      event({ type: 'subscription.updated', eventCreatedAt: EARLIER, status: 'active' }),
    )

    expect(tx.webhookEvent.create).toHaveBeenCalledTimes(1)
    expect(tx.webhookEvent.update.mock.calls[0]![0].data).toMatchObject({ outcome: 'stale' })
    expect(tx.auditLog.create.mock.calls[0]![0].data.payload).toMatchObject({ outcome: 'stale' })
  })

  // Strict `<`. Two events the provider stamped in the same second are serialised by the
  // transaction anyway, and dropping the second would lose a real state change.
  it('applies an event stamped at exactly the high-water mark', async () => {
    const tx = tables()
    tx.operatorSubscription.findUnique.mockResolvedValue(live())

    const outcome = await service(tx).process(
      event({ type: 'subscription.updated', eventCreatedAt: NOW, status: 'past_due' }),
    )

    expect(outcome).toBe('processed')
  })

  // NULL means "no provider event has touched this row yet" — an administrator's manual
  // assignment, or a row predating the column. Treating that as a mark would drop the next
  // genuine event and strand the tenant.
  it('applies the first event to reach a row that has no high-water mark yet', async () => {
    const tx = tables()
    tx.operatorSubscription.findUnique.mockResolvedValue(live({ lastEventAt: null }))

    const outcome = await service(tx).process(
      event({ type: 'subscription.updated', eventCreatedAt: EARLIER, status: 'past_due' }),
    )

    expect(outcome).toBe('processed')
  })
})

describe('OperatorSubscriptionEventsService — subscription.deleted', () => {
  it('cancels the subscription and stamps when', async () => {
    const tx = tables()
    tx.operatorSubscription.findUnique.mockResolvedValue({
      id: 'sub_existing',
      status: SubscriptionStatus.ACTIVE,
      providerSubscriptionId: 'sub_1',
      lastEventAt: null,
    })

    const outcome = await service(tx).process(
      event({ type: 'subscription.deleted', status: 'canceled' }),
    )

    expect(outcome).toBe('processed')
    expect(tx.operatorSubscription.update.mock.calls[0]![0].data).toMatchObject({
      status: SubscriptionStatus.CANCELLED,
      cancelledAt: expect.any(Date),
    })
  })

  it('is idempotent against an already-cancelled subscription', async () => {
    const tx = tables()
    tx.operatorSubscription.findUnique.mockResolvedValue({
      id: 'sub_existing',
      status: SubscriptionStatus.CANCELLED,
      providerSubscriptionId: 'sub_1',
      lastEventAt: null,
    })

    const outcome = await service(tx).process(event({ type: 'subscription.deleted' }))

    expect(outcome).toBe('already_applied')
    expect(tx.operatorSubscription.update).not.toHaveBeenCalled()
  })
})

describe('OperatorSubscriptionEventsService — invoice.payment_failed', () => {
  it('moves a live subscription to PAST_DUE rather than revoking it', async () => {
    const tx = tables()
    tx.operatorSubscription.findUnique.mockResolvedValue({
      id: 'sub_existing',
      status: SubscriptionStatus.ACTIVE,
      providerSubscriptionId: 'sub_1',
      lastEventAt: null,
    })

    const outcome = await service(tx).process(
      event({ type: 'invoice.payment_failed', status: 'past_due' }),
    )

    expect(outcome).toBe('processed')
    expect(tx.operatorSubscription.update.mock.calls[0]![0].data).toEqual({
      status: SubscriptionStatus.PAST_DUE,
      lastEventAt: NOW,
    })
  })

  it('does not apply PAST_DUE twice', async () => {
    const tx = tables()
    tx.operatorSubscription.findUnique.mockResolvedValue({
      id: 'sub_existing',
      status: SubscriptionStatus.PAST_DUE,
      providerSubscriptionId: 'sub_1',
      lastEventAt: null,
    })

    expect(await service(tx).process(event({ type: 'invoice.payment_failed' }))).toBe(
      'already_applied',
    )
    expect(tx.operatorSubscription.update).not.toHaveBeenCalled()
  })

  // CANCELLED is terminal. Reviving it would also put two live rows on an operator who has
  // since resubscribed, which the partial unique index would reject outright.
  it('never revives a cancelled subscription out of order', async () => {
    const tx = tables()
    tx.operatorSubscription.findUnique.mockResolvedValue({
      id: 'sub_existing',
      status: SubscriptionStatus.CANCELLED,
      providerSubscriptionId: 'sub_1',
      lastEventAt: null,
    })

    expect(await service(tx).process(event({ type: 'invoice.payment_failed' }))).toBe('stale')
    expect(tx.operatorSubscription.update).not.toHaveBeenCalled()
  })
})
