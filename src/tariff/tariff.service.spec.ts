import { LifecycleStatus, RateUnit, CapScope, type VehicleType } from '@prisma/client'
import { TariffService } from './tariff.service'
import { priceStay } from './pricing-engine'
import type { CompiledPlan, CompiledCap } from './tariff.types'
import type { OperatorScopeService } from '../common/authz/operator-scope.service'
import { DomainError, NoApplicableTariffError } from '../common/errors/domain.errors'
import type { LifecycleService } from '../lifecycle/lifecycle.service'
import type { PrismaService } from '../prisma/prisma.service'
import type { DriverEntitlementService } from '../subscriptions/driver-entitlement.service'
import type { EntitlementService } from '../subscriptions/entitlement.service'

import type { QuotaThresholdService } from '../subscriptions/quota-threshold.service'

const quotaThresholdStub = (): { checkOperatorQuotaThresholds: jest.Mock } => ({
  checkOperatorQuotaThresholds: jest.fn().mockResolvedValue(undefined),
})

const CAR = 'CAR' as VehicleType

/** The operator subscription TariffService reads the platform's take-rate from. */
const entitlementsWith = (commissionBps: number) => ({
  resolveEffective: jest.fn().mockResolvedValue({ entitlements: { commissionBps } }),
})

/** The rider subscription TariffService reads a booking discount from. */
const driverEntitlementsWith = (bookingDiscountBps: number | null) => ({
  resolveEffective: jest.fn().mockResolvedValue({ entitlements: { bookingDiscountBps } }),
})

interface TierInput {
  id: string
  fromMinute: number
  toMinute: number | null
  unit: RateUnit
  blockMinutes?: number | null
}
interface WindowInput {
  id: string
  label: string
  dayMask?: number
  startMinute: number
  endMinute: number
}

function plan(opts: {
  timezone?: string
  graceMinutes?: number
  incrementMinutes?: number
  tiers: TierInput[]
  windows: WindowInput[]
  prices: Record<string, number>
  caps?: CompiledCap[]
}): CompiledPlan {
  return {
    id: 'plan1',
    version: 1,
    timezone: opts.timezone ?? 'Europe/Athens',
    graceMinutes: opts.graceMinutes ?? 0,
    incrementMinutes: opts.incrementMinutes ?? 1,
    currency: 'EUR',
    tiers: opts.tiers.map((t) => ({
      id: t.id,
      fromMinute: t.fromMinute,
      toMinute: t.toMinute,
      unit: t.unit,
      blockMinutes: t.blockMinutes ?? null,
    })),
    windows: opts.windows.map((w) => ({
      id: w.id,
      label: w.label,
      dayMask: w.dayMask ?? 127,
      startMinute: w.startMinute,
      endMinute: w.endMinute,
    })),
    caps: opts.caps ?? [],
    price: (tierId, windowId) => opts.prices[`${tierId}|${windowId}`],
  }
}

const ALL_DAY: WindowInput = { id: 'wAll', label: 'All day', startMinute: 0, endMinute: 1440 }

describe('pricing-engine.priceStay', () => {
  it('prices a fixed hourly rate (PER_BLOCK 60)', () => {
    const p = plan({
      tiers: [
        { id: 't', fromMinute: 0, toMinute: null, unit: RateUnit.PER_BLOCK, blockMinutes: 60 },
      ],
      windows: [ALL_DAY],
      prices: { 't|wAll': 200 },
    })
    const r = priceStay(new Date('2026-06-18T10:00:00Z'), new Date('2026-06-18T12:00:00Z'), p, 0, null)
    expect(r.totalCents).toBe(400)
    expect(r.lineItems).toHaveLength(1)
    expect(r.lineItems[0]).toMatchObject({ unitPriceCents: 200, quantity: 2, subtotalCents: 400 })
  })

  it('partial hour rounds up to a full block', () => {
    const p = plan({
      tiers: [
        { id: 't', fromMinute: 0, toMinute: null, unit: RateUnit.PER_BLOCK, blockMinutes: 60 },
      ],
      windows: [ALL_DAY],
      prices: { 't|wAll': 200 },
    })
    const r = priceStay(new Date('2026-06-18T10:00:00Z'), new Date('2026-06-18T11:01:00Z'), p, 0, null)
    expect(r.totalCents).toBe(400)
    expect(r.lineItems[0]!.quantity).toBe(2)
  })

  it('first 30 min flat then hourly (duration tiers)', () => {
    const p = plan({
      tiers: [
        { id: 'flat', fromMinute: 0, toMinute: 30, unit: RateUnit.FLAT },
        { id: 'hour', fromMinute: 30, toMinute: null, unit: RateUnit.PER_BLOCK, blockMinutes: 60 },
      ],
      windows: [ALL_DAY],
      prices: { 'flat|wAll': 150, 'hour|wAll': 200 },
    })
    const r = priceStay(new Date('2026-06-18T10:00:00Z'), new Date('2026-06-18T11:30:00Z'), p, 0, null)
    expect(r.totalCents).toBe(150 + 200)
    expect(r.lineItems).toHaveLength(2)
    expect(r.lineItems[0]).toMatchObject({ quantity: 1, subtotalCents: 150 })
    expect(r.lineItems[1]).toMatchObject({ quantity: 1, subtotalCents: 200 })
  })

  it('applies a grace period of free leading minutes', () => {
    const p = plan({
      graceMinutes: 15,
      incrementMinutes: 60,
      tiers: [
        { id: 't', fromMinute: 0, toMinute: null, unit: RateUnit.PER_BLOCK, blockMinutes: 60 },
      ],
      windows: [ALL_DAY],
      prices: { 't|wAll': 200 },
    })
    const within = priceStay(
      new Date('2026-06-18T10:00:00Z'),
      new Date('2026-06-18T10:15:00Z'),
      p,
      0,
      null,
    )
    expect(within.totalCents).toBe(0)
    expect(within.lineItems).toHaveLength(0)

    const over = priceStay(
      new Date('2026-06-18T10:00:00Z'),
      new Date('2026-06-18T10:30:00Z'),
      p,
      0,
      null,
    )
    expect(over.totalCents).toBe(200)
  })

  it('rounds billable minutes up to the increment (15-min)', () => {
    const p = plan({
      incrementMinutes: 15,
      tiers: [{ id: 't', fromMinute: 0, toMinute: null, unit: RateUnit.PER_MINUTE }],
      windows: [ALL_DAY],
      prices: { 't|wAll': 5 },
    })
    const r = priceStay(new Date('2026-06-18T10:00:00Z'), new Date('2026-06-18T10:07:00Z'), p, 0, null)
    expect(r.billableMinutes).toBe(15)
    expect(r.totalCents).toBe(75)
  })

  it('clamps to a daily cap (STAY scope) and appends a negative cap adjustment', () => {
    const p = plan({
      tiers: [
        { id: 't', fromMinute: 0, toMinute: null, unit: RateUnit.PER_BLOCK, blockMinutes: 60 },
      ],
      windows: [ALL_DAY],
      prices: { 't|wAll': 200 },
      caps: [{ windowMinutes: 1440, capCents: 1500, scope: CapScope.STAY }],
    })
    const r = priceStay(new Date('2026-06-18T08:00:00Z'), new Date('2026-06-18T20:00:00Z'), p, 0, null)
    expect(r.totalCents).toBe(1500)
    const adj = r.lineItems[r.lineItems.length - 1]!
    expect(adj.label).toBe('Cap adjustment')
    expect(adj.subtotalCents).toBe(1500 - 12 * 200)
    expect(r.lineItems.reduce((s, i) => s + i.subtotalCents, 0)).toBe(1500)
  })

  it('splits day vs night within one stay into separate line items at the boundary', () => {
    // Day window 06:00-22:00, Night 22:00-06:00 (wrap). Athens summer = UTC+3.
    const p = plan({
      timezone: 'Europe/Athens',
      tiers: [
        { id: 't', fromMinute: 0, toMinute: null, unit: RateUnit.PER_BLOCK, blockMinutes: 60 },
      ],
      windows: [
        { id: 'day', label: 'Day', startMinute: 360, endMinute: 1320 },
        { id: 'night', label: 'Night', startMinute: 1320, endMinute: 360 },
      ],
      prices: { 't|day': 300, 't|night': 100 },
    })
    // 20:00 -> 24:00 local (UTC 17:00 -> 21:00): 2h day (20-22) + 2h night (22-24).
    const r = priceStay(new Date('2026-06-18T17:00:00Z'), new Date('2026-06-18T21:00:00Z'), p, 0, null)
    expect(r.totalCents).toBe(2 * 300 + 2 * 100)
    expect(r.lineItems).toHaveLength(2)
    expect(r.lineItems[0]).toMatchObject({ label: 'Day', quantity: 2, subtotalCents: 600 })
    expect(r.lineItems[1]).toMatchObject({ label: 'Night', quantity: 2, subtotalCents: 200 })
  })

  it('prices a block straddling a window boundary at the block-start window', () => {
    // Day 06:00-22:00, Night otherwise. 90-min blocks. Stay 21:00-00:00 local.
    const p = plan({
      timezone: 'Europe/Athens',
      tiers: [
        { id: 't', fromMinute: 0, toMinute: null, unit: RateUnit.PER_BLOCK, blockMinutes: 90 },
      ],
      windows: [
        { id: 'day', label: 'Day', startMinute: 360, endMinute: 1320 },
        { id: 'night', label: 'Night', startMinute: 1320, endMinute: 360 },
      ],
      prices: { 't|day': 300, 't|night': 100 },
    })
    // UTC 18:00 -> 21:00 = local 21:00 -> 00:00. Block1 starts 21:00 (day, straddles
    // 22:00 but priced day), block2 starts 22:30 (night).
    const r = priceStay(new Date('2026-06-18T18:00:00Z'), new Date('2026-06-18T21:00:00Z'), p, 0, null)
    expect(r.totalCents).toBe(300 + 100)
    expect(r.lineItems[0]).toMatchObject({ label: 'Day', subtotalCents: 300 })
    expect(r.lineItems[1]).toMatchObject({ label: 'Night', subtotalCents: 100 })
  })

  it('DST spring-forward: per-minute pricing counts wall-clock window minutes correctly', () => {
    // Athens spring forward 2026-03-29 03:00 -> 04:00 (clocks jump). Day 06:00-22:00.
    // Use per-minute around the gap to assert window assignment by wall clock.
    const p = plan({
      timezone: 'Europe/Athens',
      tiers: [{ id: 't', fromMinute: 0, toMinute: null, unit: RateUnit.PER_MINUTE }],
      windows: [
        { id: 'day', label: 'Day', startMinute: 360, endMinute: 1320 },
        { id: 'night', label: 'Night', startMinute: 1320, endMinute: 360 },
      ],
      prices: { 't|day': 10, 't|night': 1 },
    })
    // Stay 01:00 local (UTC 23:00 prev day, winter UTC+2) for 2 wall-hours across the
    // spring gap -> wall clock reads 01:00 then 04:00 (03:00 skipped). All before 06:00
    // so entirely Night. 60 elapsed real minutes only (gap collapses an hour).
    const start = new Date('2026-03-28T23:00:00Z')
    const end = new Date('2026-03-29T01:00:00Z')
    const r = priceStay(start, end, p, 0, null)
    // 120 elapsed UTC minutes, all night.
    expect(r.totalCents).toBe(120 * 1)
    expect(r.lineItems).toHaveLength(1)
    expect(r.lineItems[0]!.label).toBe('Night')
  })

  it('DST fall-back: window assignment follows wall clock across the repeated hour', () => {
    // Athens fall back 2026-10-25 04:00 -> 03:00. Night before 06:00. Day 06:00-22:00.
    const p = plan({
      timezone: 'Europe/Athens',
      tiers: [{ id: 't', fromMinute: 0, toMinute: null, unit: RateUnit.PER_MINUTE }],
      windows: [
        { id: 'day', label: 'Day', startMinute: 360, endMinute: 1320 },
        { id: 'night', label: 'Night', startMinute: 1320, endMinute: 360 },
      ],
      prices: { 't|day': 10, 't|night': 1 },
    })
    // Start 04:30 local (after fall-back, UTC+2), 60 min -> 05:30 local, wall clock
    // stays < 06:00 the whole time -> all Night.
    const start = new Date('2026-10-25T02:30:00Z')
    const end = new Date('2026-10-25T03:30:00Z')
    const r = priceStay(start, end, p, 0, null)
    expect(r.lineItems).toHaveLength(1)
    expect(r.lineItems[0]!.label).toBe('Night')
    expect(r.totalCents).toBe(60 * 1)
  })

  it('throws when no window matches (incomplete schedule)', () => {
    const p = plan({
      tiers: [
        { id: 't', fromMinute: 0, toMinute: null, unit: RateUnit.PER_BLOCK, blockMinutes: 60 },
      ],
      windows: [{ id: 'day', label: 'Day', startMinute: 360, endMinute: 1320 }],
      prices: { 't|day': 200 },
    })
    // 02:00 local has no covering window.
    expect(() =>
      priceStay(new Date('2026-06-17T23:00:00Z'), new Date('2026-06-18T00:00:00Z'), p, 0, null),
    ).toThrow()
  })

  it('throws when a (tier,window) rate is missing', () => {
    const p = plan({
      tiers: [
        { id: 't', fromMinute: 0, toMinute: null, unit: RateUnit.PER_BLOCK, blockMinutes: 60 },
      ],
      windows: [ALL_DAY],
      prices: {},
    })
    expect(() =>
      priceStay(new Date('2026-06-18T10:00:00Z'), new Date('2026-06-18T11:00:00Z'), p, 0, null),
    ).toThrow()
  })
})

describe('pricing-engine commission', () => {
  const hourly = (cents: number) =>
    plan({
      tiers: [
        { id: 't', fromMinute: 0, toMinute: null, unit: RateUnit.PER_BLOCK, blockMinutes: 60 },
      ],
      windows: [ALL_DAY],
      prices: { 't|wAll': cents },
    })

  const twoHours = (p: CompiledPlan, bps: number) =>
    priceStay(new Date('2026-06-18T10:00:00Z'), new Date('2026-06-18T12:00:00Z'), p, bps, null)

  it('takes nothing on a plan with no commission', () => {
    const r = twoHours(hourly(200), 0)
    expect(r.totalCents).toBe(400)
    expect(r.commissionBps).toBe(0)
    expect(r.commissionCents).toBe(0)
  })

  it('takes the plan’s basis points of the total on a commissioned plan', () => {
    const r = twoHours(hourly(200), 250)
    expect(r.totalCents).toBe(400)
    expect(r.commissionBps).toBe(250)
    expect(r.commissionCents).toBe(10)
  })

  it('rounds the take to whole cents and never above the total', () => {
    // 175 bps of 333c is 5.8275c.
    const r = priceStay(
      new Date('2026-06-18T10:00:00Z'),
      new Date('2026-06-18T11:00:00Z'),
      hourly(333),
      175,
      null,
    )
    expect(r.commissionCents).toBe(6)
    expect(r.commissionCents).toBeLessThanOrEqual(r.totalCents)
  })

  it('leaves what the driver pays untouched', () => {
    expect(twoHours(hourly(200), 1_000).totalCents).toBe(twoHours(hourly(200), 0).totalCents)
    expect(twoHours(hourly(200), 1_000).lineItems).toEqual(twoHours(hourly(200), 0).lineItems)
  })

  // A capped stay took less money, so the platform's share of it is smaller too.
  it('applies to the capped total, not the pre-cap one', () => {
    const capped = plan({
      tiers: [
        { id: 't', fromMinute: 0, toMinute: null, unit: RateUnit.PER_BLOCK, blockMinutes: 60 },
      ],
      windows: [ALL_DAY],
      prices: { 't|wAll': 200 },
      caps: [{ windowMinutes: 1440, capCents: 300, scope: CapScope.STAY }],
    })
    const r = twoHours(capped, 1_000)
    expect(r.totalCents).toBe(300)
    expect(r.commissionCents).toBe(30)
  })

  it('reports zero on a stay that is entirely inside the grace period', () => {
    const graced = plan({
      graceMinutes: 30,
      tiers: [
        { id: 't', fromMinute: 0, toMinute: null, unit: RateUnit.PER_BLOCK, blockMinutes: 60 },
      ],
      windows: [ALL_DAY],
      prices: { 't|wAll': 200 },
    })
    const r = priceStay(
      new Date('2026-06-18T10:00:00Z'),
      new Date('2026-06-18T10:15:00Z'),
      graced,
      500,
      null,
    )
    expect(r.totalCents).toBe(0)
    expect(r.commissionCents).toBe(0)
  })
})

describe('pricing-engine rider subscription discount', () => {
  const hourly = (cents: number, caps?: CompiledCap[]) =>
    plan({
      tiers: [
        { id: 't', fromMinute: 0, toMinute: null, unit: RateUnit.PER_BLOCK, blockMinutes: 60 },
      ],
      windows: [ALL_DAY],
      prices: { 't|wAll': cents },
      ...(caps ? { caps } : {}),
    })

  const twoHours = (p: CompiledPlan, commissionBps: number, discountBps: number | null) =>
    priceStay(
      new Date('2026-06-18T10:00:00Z'),
      new Date('2026-06-18T12:00:00Z'),
      p,
      commissionBps,
      discountBps,
    )

  it('charges the schedule price when no rider is identified', () => {
    const r = twoHours(hourly(200), 0, null)

    expect(r.totalCents).toBe(400)
    expect(r.discountCents).toBe(0)
    expect(r.lineItems.map((l) => l.label)).not.toContain('Subscription discount')
  })

  // Distinct from `null` in intent only: a plan that grants a discount of zero and no plan at
  // all must cost the rider the same.
  it('charges the schedule price on a plan whose discount is zero', () => {
    expect(twoHours(hourly(200), 0, 0).totalCents).toBe(400)
    expect(twoHours(hourly(200), 0, 0).discountCents).toBe(0)
  })

  it('takes the plan’s basis points off the total for a subscribed rider', () => {
    const r = twoHours(hourly(200), 0, 1_000)

    expect(r.totalCents).toBe(360)
    expect(r.discountCents).toBe(40)
  })

  // The rider has to SEE the perk. A total that is simply smaller than the schedule implies
  // reads as a pricing bug rather than a benefit.
  it('shows the discount as its own negative line item', () => {
    const r = twoHours(hourly(200), 0, 1_000)
    const discount = r.lineItems.find((l) => l.label === 'Subscription discount')

    expect(discount).toMatchObject({ subtotalCents: -40, quantity: 1 })
    expect(r.lineItems.reduce((sum, l) => sum + l.subtotalCents, 0)).toBe(r.totalCents)
  })

  /**
   * The ordering invariant, and the reason the discount is applied where it is. Commission
   * tracks what was actually charged: taking it before the discount would bill the operator
   * a share of money the platform gave away, and discounting before the cap would hand a
   * capped stay a reduction larger than the cap ever charged for.
   */
  it('applies after caps and before commission', () => {
    const capped = hourly(200, [{ windowMinutes: 1440, capCents: 300, scope: CapScope.STAY }])

    const r = twoHours(capped, 1_000, 1_000)

    // 400 raw -> 300 capped -> 30 off -> 270 charged -> 10% commission of 270.
    expect(r.discountCents).toBe(30)
    expect(r.totalCents).toBe(270)
    expect(r.commissionCents).toBe(27)
  })

  it('never discounts below zero, whatever the plan promises', () => {
    const r = twoHours(hourly(200), 250, 10_000)

    expect(r.totalCents).toBe(0)
    expect(r.discountCents).toBe(400)
    expect(r.commissionCents).toBe(0)
  })

  it('reports zero on a stay entirely inside the grace period', () => {
    const graced = plan({
      graceMinutes: 30,
      tiers: [
        { id: 't', fromMinute: 0, toMinute: null, unit: RateUnit.PER_BLOCK, blockMinutes: 60 },
      ],
      windows: [ALL_DAY],
      prices: { 't|wAll': 200 },
    })

    const r = priceStay(
      new Date('2026-06-18T10:00:00Z'),
      new Date('2026-06-18T10:15:00Z'),
      graced,
      0,
      5_000,
    )

    expect(r.totalCents).toBe(0)
    expect(r.discountCents).toBe(0)
  })

  it('rounds the reduction to whole cents', () => {
    // 175 bps of 333c is 5.8275c.
    const r = priceStay(
      new Date('2026-06-18T10:00:00Z'),
      new Date('2026-06-18T11:00:00Z'),
      hourly(333),
      0,
      175,
    )

    expect(r.discountCents).toBe(6)
    expect(r.totalCents).toBe(327)
  })
})

describe('TariffService.computeTotalsByFacility', () => {
  let prisma: { facility: { findMany: jest.Mock }; tariffPlan: { findMany: jest.Mock } }
  let service: TariffService

  const startsAt = new Date('2026-06-18T10:00:00Z')
  const endsAt = new Date('2026-06-18T12:00:00Z')

  function dbPlan(hourlyCents: number, over: Record<string, unknown> = {}) {
    return {
      id: 'p',
      operatorId: 'op1',
      isActive: true,
      lifecycleStatus: LifecycleStatus.ACTIVE,
      validFrom: null,
      validTo: null,
      vehicleTypes: [] as VehicleType[],
      version: 1,
      timezone: 'Europe/Athens',
      graceMinutes: 0,
      incrementMinutes: 60,
      tiers: [
        {
          id: 't',
          fromMinute: 0,
          toMinute: null,
          unit: RateUnit.PER_BLOCK,
          blockMinutes: 60,
          rates: [{ tierId: 't', windowId: 'w', priceCents: hourlyCents, currency: 'EUR' }],
        },
      ],
      windows: [
        {
          id: 'w',
          label: 'All day',
          dayMask: 127,
          startMinute: 0,
          endMinute: 1440,
          rates: [{ tierId: 't', windowId: 'w', priceCents: hourlyCents, currency: 'EUR' }],
        },
      ],
      caps: [],
      ...over,
    }
  }

  // A facility with an explicit CAR-vehicleType row carrying the plan (or no row at all).
  function facilityWithPlan(id: string, plan: unknown, operatorId = 'op1') {
    return {
      id,
      operatorId,
      tariffAssignments: plan ? [{ vehicleType: CAR, tariffPlan: plan }] : [],
    }
  }

  function facilityNoRow(id: string, operatorId = 'op1') {
    return {
      id,
      operatorId,
      tariffAssignments: [] as { vehicleType: VehicleType; tariffPlan: unknown }[],
    }
  }

  beforeEach(() => {
    prisma = {
      facility: { findMany: jest.fn() },
      tariffPlan: { findMany: jest.fn().mockResolvedValue([]) },
    }
    service = new TariffService(
      prisma as unknown as PrismaService,
      {} as unknown as OperatorScopeService,
      entitlementsWith(0) as unknown as EntitlementService,
      {} as unknown as LifecycleService,
      driverEntitlementsWith(null) as unknown as DriverEntitlementService,
      quotaThresholdStub() as unknown as QuotaThresholdService,
    )
  })

  it('totals each facility from its explicit assigned plan in a fixed two queries', async () => {
    prisma.facility.findMany.mockResolvedValue([
      facilityWithPlan('f1', dbPlan(400)),
      facilityWithPlan('f2', dbPlan(750)),
    ])

    const totals = await service.computeTotalsByFacility(['f1', 'f2'], startsAt, endsAt, CAR)

    // One facility findMany, plus one tariffPlan findMany for the batched defaults.
    expect(prisma.facility.findMany).toHaveBeenCalledTimes(1)
    expect(prisma.tariffPlan.findMany).toHaveBeenCalledTimes(1)
    expect(totals.get('f1')).toBe(800)
    expect(totals.get('f2')).toBe(1500)
  })

  it('omits a facility with no explicit row and no operator default', async () => {
    prisma.facility.findMany.mockResolvedValue([
      facilityWithPlan('f1', dbPlan(400)),
      facilityNoRow('f2'),
    ])

    const totals = await service.computeTotalsByFacility(['f1', 'f2'], startsAt, endsAt, CAR)

    expect(totals.get('f1')).toBe(800)
    expect(totals.has('f2')).toBe(false)
  })

  it('omits a facility whose explicit plan is inactive', async () => {
    prisma.facility.findMany.mockResolvedValue([
      facilityWithPlan('f1', dbPlan(400)),
      facilityWithPlan('f2', dbPlan(750, { isActive: false })),
    ])

    const totals = await service.computeTotalsByFacility(['f1', 'f2'], startsAt, endsAt, CAR)

    expect(totals.get('f1')).toBe(800)
    expect(totals.has('f2')).toBe(false)
  })

  it('omits a facility whose plan does not cover the vehicle type', async () => {
    prisma.facility.findMany.mockResolvedValue([
      facilityWithPlan('f1', dbPlan(400, { vehicleTypes: ['TRUCK'] as VehicleType[] })),
    ])

    const totals = await service.computeTotalsByFacility(['f1'], startsAt, endsAt, CAR)

    expect(totals.has('f1')).toBe(false)
  })

  it('omits facilities whose plan has no applicable price', async () => {
    const broken = dbPlan(0)
    broken.windows[0]!.rates = []
    broken.tiers[0]!.rates = []
    prisma.facility.findMany.mockResolvedValue([
      facilityWithPlan('f1', dbPlan(400)),
      facilityWithPlan('f2', broken),
    ])

    const totals = await service.computeTotalsByFacility(['f1', 'f2'], startsAt, endsAt, CAR)

    expect(totals.get('f1')).toBe(800)
    expect(totals.has('f2')).toBe(false)
  })

  it('skips both queries for empty ids or a non-positive window', async () => {
    expect((await service.computeTotalsByFacility([], startsAt, endsAt, CAR)).size).toBe(0)
    expect((await service.computeTotalsByFacility(['f1'], endsAt, startsAt, CAR)).size).toBe(0)
    expect(prisma.facility.findMany).not.toHaveBeenCalled()
    expect(prisma.tariffPlan.findMany).not.toHaveBeenCalled()
  })

  it('queries the given facility ids and loads only the exact-vehicleType row', async () => {
    prisma.facility.findMany.mockResolvedValue([])
    await service.computeTotalsByFacility(['f1'], startsAt, endsAt, CAR)
    const call = prisma.facility.findMany.mock.calls[0][0]
    expect(call.where).toEqual({ id: { in: ['f1'] } })
    expect(call.select.tariffAssignments.where).toEqual({ vehicleType: CAR })
  })

  it('falls back to the operator default when there is no explicit row', async () => {
    prisma.facility.findMany.mockResolvedValue([facilityNoRow('f1')])
    prisma.tariffPlan.findMany.mockResolvedValue([dbPlan(400)])

    const totals = await service.computeTotalsByFacility(['f1'], startsAt, endsAt, CAR)

    expect(totals.get('f1')).toBe(800)
  })

  it('prefers the explicit row over the operator default when both exist', async () => {
    prisma.facility.findMany.mockResolvedValue([facilityWithPlan('f1', dbPlan(750))])
    prisma.tariffPlan.findMany.mockResolvedValue([dbPlan(400)])

    const totals = await service.computeTotalsByFacility(['f1'], startsAt, endsAt, CAR)

    // 750/h from the explicit row, not 400/h from the default.
    expect(totals.get('f1')).toBe(1500)
  })

  it('batches the defaults query by DISTINCT operator, not per facility', async () => {
    // f1,f2 on op1; f3 on op2 — three facilities, two distinct operators.
    prisma.facility.findMany.mockResolvedValue([
      facilityNoRow('f1', 'op1'),
      facilityNoRow('f2', 'op1'),
      facilityNoRow('f3', 'op2'),
    ])
    prisma.tariffPlan.findMany.mockResolvedValue([
      dbPlan(400, { operatorId: 'op1' }),
      dbPlan(600, { operatorId: 'op2' }),
    ])

    const totals = await service.computeTotalsByFacility(['f1', 'f2', 'f3'], startsAt, endsAt, CAR)

    expect(prisma.tariffPlan.findMany).toHaveBeenCalledTimes(1)
    expect(prisma.tariffPlan.findMany.mock.calls[0]![0].where).toEqual({
      operatorId: { in: ['op1', 'op2'] },
      isDefault: true,
      isActive: true,
    })
    expect(totals.get('f1')).toBe(800)
    expect(totals.get('f2')).toBe(800)
    expect(totals.get('f3')).toBe(1200)
  })

  it('an operator-less facility with an explicit row still prices, excluded from the defaults query', async () => {
    prisma.facility.findMany.mockResolvedValue([
      facilityWithPlan('f1', dbPlan(400), null as unknown as string),
      facilityNoRow('f2', 'op1'),
    ])
    prisma.tariffPlan.findMany.mockResolvedValue([dbPlan(600, { operatorId: 'op1' })])

    const totals = await service.computeTotalsByFacility(['f1', 'f2'], startsAt, endsAt, CAR)

    expect(prisma.tariffPlan.findMany.mock.calls[0]![0].where.operatorId).toEqual({ in: ['op1'] })
    expect(totals.get('f1')).toBe(800)
    expect(totals.get('f2')).toBe(1200)
  })

  it('an operator-less facility with no explicit row is omitted, not crashed', async () => {
    prisma.facility.findMany.mockResolvedValue([facilityNoRow('f1', null as unknown as string)])

    const totals = await service.computeTotalsByFacility(['f1'], startsAt, endsAt, CAR)

    expect(totals.has('f1')).toBe(false)
    expect(prisma.tariffPlan.findMany).not.toHaveBeenCalled()
  })
})

describe('TariffService.computeQuote', () => {
  it('rejects endsAt not after startsAt with a DomainError (400), not a raw Error', async () => {
    const prisma = { facility: { findFirst: jest.fn() } }
    const service = new TariffService(
      prisma as unknown as PrismaService,
      {} as unknown as OperatorScopeService,
      entitlementsWith(0) as unknown as EntitlementService,
      {} as unknown as LifecycleService,
      driverEntitlementsWith(null) as unknown as DriverEntitlementService,
      quotaThresholdStub() as unknown as QuotaThresholdService,
    )

    const badStartsAt = new Date('2026-06-18T10:00:00Z')
    const badEndsAt = new Date('2026-06-18T09:00:00Z')

    await expect(
      service.computeQuote({
        facilityId: 'f1',
        startsAt: badStartsAt,
        endsAt: badEndsAt,
        vehicleType: CAR,
      }),
    ).rejects.toBeInstanceOf(DomainError)
    expect(prisma.facility.findFirst).not.toHaveBeenCalled()
  })

  it('an operator-less facility with no explicit assignment is refused, not crashed', async () => {
    const prisma = {
      facility: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'f1',
          operatorId: null,
          tariffAssignments: [],
        }),
      },
      tariffPlan: { findFirst: jest.fn() },
    }
    const service = new TariffService(
      prisma as unknown as PrismaService,
      {} as unknown as OperatorScopeService,
      entitlementsWith(0) as unknown as EntitlementService,
      {} as unknown as LifecycleService,
      driverEntitlementsWith(null) as unknown as DriverEntitlementService,
      quotaThresholdStub() as unknown as QuotaThresholdService,
    )

    await expect(
      service.computeQuote({
        facilityId: 'f1',
        startsAt: new Date('2026-06-18T10:00:00Z'),
        endsAt: new Date('2026-06-18T12:00:00Z'),
        vehicleType: CAR,
      }),
    ).rejects.toBeInstanceOf(NoApplicableTariffError)
    // No operator to resolve a default plan from — the query is skipped entirely.
    expect(prisma.tariffPlan.findFirst).not.toHaveBeenCalled()
  })
})

/**
 * Where the rider's perk actually reaches a price. The unauthenticated preview at
 * `GET /facilities/:id/quote` passes no userId and must stay impersonal; booking creation
 * passes one, and that is the only place a discount is applied.
 */
describe('TariffService.computeQuote — rider discount', () => {
  const startsAt = new Date('2026-06-18T10:00:00Z')
  const endsAt = new Date('2026-06-18T12:00:00Z')

  function quotableFacility(hourlyCents: number) {
    const rates = [{ tierId: 't', windowId: 'w', priceCents: hourlyCents, currency: 'EUR' }]
    return {
      id: 'f1',
      operatorId: 'op1',
      tariffAssignments: [
        {
          tariffPlan: {
            id: 'p',
            operatorId: 'op1',
            isActive: true,
            lifecycleStatus: LifecycleStatus.ACTIVE,
            validFrom: null,
            validTo: null,
            vehicleTypes: [] as VehicleType[],
            version: 1,
            timezone: 'Europe/Athens',
            graceMinutes: 0,
            incrementMinutes: 60,
            tiers: [
              {
                id: 't',
                fromMinute: 0,
                toMinute: null,
                unit: RateUnit.PER_BLOCK,
                blockMinutes: 60,
                rates,
              },
            ],
            windows: [
              { id: 'w', label: 'All day', dayMask: 127, startMinute: 0, endMinute: 1440, rates },
            ],
            caps: [],
          },
        },
      ],
    }
  }

  function serviceWith(commissionBps: number, discountBps: number | null) {
    const prisma = {
      facility: { findFirst: jest.fn().mockResolvedValue(quotableFacility(200)) },
      tariffPlan: { findFirst: jest.fn() },
    }
    const driver = driverEntitlementsWith(discountBps)
    const service = new TariffService(
      prisma as unknown as PrismaService,
      {} as unknown as OperatorScopeService,
      entitlementsWith(commissionBps) as unknown as EntitlementService,
      {} as unknown as LifecycleService,
      driver as unknown as DriverEntitlementService,
      quotaThresholdStub() as unknown as QuotaThresholdService,
    )
    return { service, driver }
  }

  it('does not resolve any rider entitlement for an anonymous quote', async () => {
    const { service, driver } = serviceWith(0, 1_000)

    const quote = await service.computeQuote({ facilityId: 'f1', startsAt, endsAt, vehicleType: CAR })

    expect(driver.resolveEffective).not.toHaveBeenCalled()
    expect(quote.totalCents).toBe(400)
    expect(quote.discountCents).toBe(0)
  })

  it('resolves the named rider’s plan and applies it to the quoted total', async () => {
    const { service, driver } = serviceWith(0, 1_000)

    const quote = await service.computeQuote({
      facilityId: 'f1',
      startsAt,
      endsAt,
      vehicleType: CAR,
      userId: 'u1',
    })

    expect(driver.resolveEffective).toHaveBeenCalledWith('u1')
    expect(quote.totalCents).toBe(360)
    expect(quote.discountCents).toBe(40)
  })

  it('leaves a free-tier rider at the schedule price', async () => {
    const { service, driver } = serviceWith(0, null)

    const quote = await service.computeQuote({
      facilityId: 'f1',
      startsAt,
      endsAt,
      vehicleType: CAR,
      userId: 'u1',
    })

    expect(driver.resolveEffective).toHaveBeenCalledWith('u1')
    expect(quote.totalCents).toBe(400)
    expect(quote.discountCents).toBe(0)
  })
})

describe('TariffService.priceWithPinnedPlan', () => {
  let prisma: { tariffPlan: { findFirst: jest.Mock } }
  let service: TariffService

  const startsAt = new Date('2026-06-18T10:00:00Z')
  const endsAt = new Date('2026-06-18T13:00:00Z')

  function pinnedPlan(hourlyCents: number, version: number) {
    return {
      id: 'p',
      operatorId: 'op1',
      isActive: true,
      validFrom: null,
      validTo: null,
      vehicleTypes: [] as VehicleType[],
      version,
      timezone: 'Europe/Athens',
      graceMinutes: 0,
      incrementMinutes: 60,
      tiers: [
        {
          id: 't',
          fromMinute: 0,
          toMinute: null,
          unit: RateUnit.PER_BLOCK,
          blockMinutes: 60,
          rates: [{ tierId: 't', windowId: 'w', priceCents: hourlyCents, currency: 'EUR' }],
        },
      ],
      windows: [
        {
          id: 'w',
          label: 'All day',
          dayMask: 127,
          startMinute: 0,
          endMinute: 1440,
          rates: [{ tierId: 't', windowId: 'w', priceCents: hourlyCents, currency: 'EUR' }],
        },
      ],
      caps: [],
    }
  }

  beforeEach(() => {
    prisma = { tariffPlan: { findFirst: jest.fn() } }
    service = new TariffService(
      prisma as unknown as PrismaService,
      {} as unknown as OperatorScopeService,
      entitlementsWith(0) as unknown as EntitlementService,
      {} as unknown as LifecycleService,
      driverEntitlementsWith(null) as unknown as DriverEntitlementService,
      quotaThresholdStub() as unknown as QuotaThresholdService,
    )
  })

  it('queries the exact (id, version) pin and prices the span against it', async () => {
    prisma.tariffPlan.findFirst.mockResolvedValue(pinnedPlan(400, 3))

    const result = await service.priceWithPinnedPlan({
      planId: 'p',
      planVersion: 3,
      startsAt,
      endsAt,
    })

    // The explicit lifecycle opt-out is load-bearing: a pinned reprice must resolve the
    // plan even after it is archived or tombstoned.
    expect(prisma.tariffPlan.findFirst.mock.calls[0]![0].where).toEqual({
      id: 'p',
      version: 3,
      lifecycleStatus: { in: Object.values(LifecycleStatus) },
    })
    expect(result).toEqual({
      totalCents: 1200,
      discountCents: 0,
      currency: 'EUR',
      billableMinutes: 180,
      commissionCents: 0,
    })
  })

  it('returns null for a pin the live plan no longer matches', async () => {
    // findFirst filters on version, so a bumped plan simply does not match the pin.
    prisma.tariffPlan.findFirst.mockResolvedValue(null)

    await expect(
      service.priceWithPinnedPlan({ planId: 'p', planVersion: 3, startsAt, endsAt }),
    ).resolves.toBeNull()
  })

  it('prices a retired plan: applicability gates new quotes, not settled ones', async () => {
    prisma.tariffPlan.findFirst.mockResolvedValue({
      ...pinnedPlan(400, 3),
      isActive: false,
      validTo: new Date('2026-06-01T00:00:00Z'),
    })

    const result = await service.priceWithPinnedPlan({
      planId: 'p',
      planVersion: 3,
      startsAt,
      endsAt,
    })

    expect(result?.totalCents).toBe(1200)
  })

  // The take-rate comes off the OPERATOR's subscription, not the tariff plan, so changing
  // commission never requires an operator to re-publish their prices.
  it('applies the owning operator’s commission to the repriced total', async () => {
    const entitlements = entitlementsWith(250)
    const commissioned = new TariffService(
      prisma as unknown as PrismaService,
      {} as unknown as OperatorScopeService,
      entitlements as unknown as EntitlementService,
      {} as unknown as LifecycleService,
      driverEntitlementsWith(null) as unknown as DriverEntitlementService,
      quotaThresholdStub() as unknown as QuotaThresholdService,
    )
    prisma.tariffPlan.findFirst.mockResolvedValue(pinnedPlan(400, 3))

    const result = await commissioned.priceWithPinnedPlan({
      planId: 'p',
      planVersion: 3,
      startsAt,
      endsAt,
    })

    expect(entitlements.resolveEffective).toHaveBeenCalledWith('op1')
    expect(result?.totalCents).toBe(1200)
    expect(result?.commissionCents).toBe(30)
  })

  it('rejects a non-positive span with a DomainError before touching the database', async () => {
    await expect(
      service.priceWithPinnedPlan({ planId: 'p', planVersion: 3, startsAt: endsAt, endsAt }),
    ).rejects.toBeInstanceOf(DomainError)
    expect(prisma.tariffPlan.findFirst).not.toHaveBeenCalled()
  })

  /**
   * Without this the rider would be quoted a discounted price at booking and billed the
   * undiscounted one at the barrier — the pricing bug this whole parameter exists to prevent.
   */
  it('carries the booking owner’s discount into the check-out reprice', async () => {
    const driver = driverEntitlementsWith(1_000)
    const discounted = new TariffService(
      prisma as unknown as PrismaService,
      {} as unknown as OperatorScopeService,
      entitlementsWith(250) as unknown as EntitlementService,
      {} as unknown as LifecycleService,
      driver as unknown as DriverEntitlementService,
      quotaThresholdStub() as unknown as QuotaThresholdService,
    )
    prisma.tariffPlan.findFirst.mockResolvedValue(pinnedPlan(400, 3))

    const result = await discounted.priceWithPinnedPlan({
      planId: 'p',
      planVersion: 3,
      startsAt,
      endsAt,
      userId: 'u1',
    })

    expect(driver.resolveEffective).toHaveBeenCalledWith('u1')
    // 1200 charged -> 120 off -> 1080 billed -> 250 bps of 1080.
    expect(result?.discountCents).toBe(120)
    expect(result?.totalCents).toBe(1_080)
    expect(result?.commissionCents).toBe(27)
  })
})
