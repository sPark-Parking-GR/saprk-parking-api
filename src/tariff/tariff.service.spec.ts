import { RateUnit, CapScope, type VehicleType } from '@prisma/client'
import { TariffService } from './tariff.service'
import { priceStay } from './pricing-engine'
import type { CompiledPlan, CompiledCap } from './tariff.types'
import type { OperatorScopeService } from '../common/authz/operator-scope.service'
import type { PrismaService } from '../prisma/prisma.service'

const CAR = 'CAR' as VehicleType

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
      tiers: [{ id: 't', fromMinute: 0, toMinute: null, unit: RateUnit.PER_BLOCK, blockMinutes: 60 }],
      windows: [ALL_DAY],
      prices: { 't|wAll': 200 },
    })
    const r = priceStay(
      new Date('2026-06-18T10:00:00Z'),
      new Date('2026-06-18T12:00:00Z'),
      p,
    )
    expect(r.totalCents).toBe(400)
    expect(r.lineItems).toHaveLength(1)
    expect(r.lineItems[0]).toMatchObject({ unitPriceCents: 200, quantity: 2, subtotalCents: 400 })
  })

  it('partial hour rounds up to a full block', () => {
    const p = plan({
      tiers: [{ id: 't', fromMinute: 0, toMinute: null, unit: RateUnit.PER_BLOCK, blockMinutes: 60 }],
      windows: [ALL_DAY],
      prices: { 't|wAll': 200 },
    })
    const r = priceStay(
      new Date('2026-06-18T10:00:00Z'),
      new Date('2026-06-18T11:01:00Z'),
      p,
    )
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
    const r = priceStay(
      new Date('2026-06-18T10:00:00Z'),
      new Date('2026-06-18T11:30:00Z'),
      p,
    )
    expect(r.totalCents).toBe(150 + 200)
    expect(r.lineItems).toHaveLength(2)
    expect(r.lineItems[0]).toMatchObject({ quantity: 1, subtotalCents: 150 })
    expect(r.lineItems[1]).toMatchObject({ quantity: 1, subtotalCents: 200 })
  })

  it('applies a grace period of free leading minutes', () => {
    const p = plan({
      graceMinutes: 15,
      incrementMinutes: 60,
      tiers: [{ id: 't', fromMinute: 0, toMinute: null, unit: RateUnit.PER_BLOCK, blockMinutes: 60 }],
      windows: [ALL_DAY],
      prices: { 't|wAll': 200 },
    })
    const within = priceStay(
      new Date('2026-06-18T10:00:00Z'),
      new Date('2026-06-18T10:15:00Z'),
      p,
    )
    expect(within.totalCents).toBe(0)
    expect(within.lineItems).toHaveLength(0)

    const over = priceStay(
      new Date('2026-06-18T10:00:00Z'),
      new Date('2026-06-18T10:30:00Z'),
      p,
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
    const r = priceStay(
      new Date('2026-06-18T10:00:00Z'),
      new Date('2026-06-18T10:07:00Z'),
      p,
    )
    expect(r.billableMinutes).toBe(15)
    expect(r.totalCents).toBe(75)
  })

  it('clamps to a daily cap (STAY scope) and appends a negative cap adjustment', () => {
    const p = plan({
      tiers: [{ id: 't', fromMinute: 0, toMinute: null, unit: RateUnit.PER_BLOCK, blockMinutes: 60 }],
      windows: [ALL_DAY],
      prices: { 't|wAll': 200 },
      caps: [{ windowMinutes: 1440, capCents: 1500, scope: CapScope.STAY }],
    })
    const r = priceStay(
      new Date('2026-06-18T08:00:00Z'),
      new Date('2026-06-18T20:00:00Z'),
      p,
    )
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
      tiers: [{ id: 't', fromMinute: 0, toMinute: null, unit: RateUnit.PER_BLOCK, blockMinutes: 60 }],
      windows: [
        { id: 'day', label: 'Day', startMinute: 360, endMinute: 1320 },
        { id: 'night', label: 'Night', startMinute: 1320, endMinute: 360 },
      ],
      prices: { 't|day': 300, 't|night': 100 },
    })
    // 20:00 -> 24:00 local (UTC 17:00 -> 21:00): 2h day (20-22) + 2h night (22-24).
    const r = priceStay(
      new Date('2026-06-18T17:00:00Z'),
      new Date('2026-06-18T21:00:00Z'),
      p,
    )
    expect(r.totalCents).toBe(2 * 300 + 2 * 100)
    expect(r.lineItems).toHaveLength(2)
    expect(r.lineItems[0]).toMatchObject({ label: 'Day', quantity: 2, subtotalCents: 600 })
    expect(r.lineItems[1]).toMatchObject({ label: 'Night', quantity: 2, subtotalCents: 200 })
  })

  it('prices a block straddling a window boundary at the block-start window', () => {
    // Day 06:00-22:00, Night otherwise. 90-min blocks. Stay 21:00-00:00 local.
    const p = plan({
      timezone: 'Europe/Athens',
      tiers: [{ id: 't', fromMinute: 0, toMinute: null, unit: RateUnit.PER_BLOCK, blockMinutes: 90 }],
      windows: [
        { id: 'day', label: 'Day', startMinute: 360, endMinute: 1320 },
        { id: 'night', label: 'Night', startMinute: 1320, endMinute: 360 },
      ],
      prices: { 't|day': 300, 't|night': 100 },
    })
    // UTC 18:00 -> 21:00 = local 21:00 -> 00:00. Block1 starts 21:00 (day, straddles
    // 22:00 but priced day), block2 starts 22:30 (night).
    const r = priceStay(
      new Date('2026-06-18T18:00:00Z'),
      new Date('2026-06-18T21:00:00Z'),
      p,
    )
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
    const r = priceStay(start, end, p)
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
    const r = priceStay(start, end, p)
    expect(r.lineItems).toHaveLength(1)
    expect(r.lineItems[0]!.label).toBe('Night')
    expect(r.totalCents).toBe(60 * 1)
  })

  it('throws when no window matches (incomplete schedule)', () => {
    const p = plan({
      tiers: [{ id: 't', fromMinute: 0, toMinute: null, unit: RateUnit.PER_BLOCK, blockMinutes: 60 }],
      windows: [{ id: 'day', label: 'Day', startMinute: 360, endMinute: 1320 }],
      prices: { 't|day': 200 },
    })
    // 02:00 local has no covering window.
    expect(() =>
      priceStay(new Date('2026-06-17T23:00:00Z'), new Date('2026-06-18T00:00:00Z'), p),
    ).toThrow()
  })

  it('throws when a (tier,window) rate is missing', () => {
    const p = plan({
      tiers: [{ id: 't', fromMinute: 0, toMinute: null, unit: RateUnit.PER_BLOCK, blockMinutes: 60 }],
      windows: [ALL_DAY],
      prices: {},
    })
    expect(() =>
      priceStay(new Date('2026-06-18T10:00:00Z'), new Date('2026-06-18T11:00:00Z'), p),
    ).toThrow()
  })
})

describe('TariffService.computeTotalsByFacility', () => {
  let prisma: { tariffPlan: { findMany: jest.Mock } }
  let service: TariffService

  const startsAt = new Date('2026-06-18T10:00:00Z')
  const endsAt = new Date('2026-06-18T12:00:00Z')

  function dbPlan(facilityId: string, hourlyCents: number) {
    return {
      id: `${facilityId}-plan`,
      facilityId,
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
    }
  }

  beforeEach(() => {
    prisma = { tariffPlan: { findMany: jest.fn() } }
    service = new TariffService(
      prisma as unknown as PrismaService,
      {} as unknown as OperatorScopeService,
    )
  })

  it('issues ONE findMany and totals the first plan per facility', async () => {
    prisma.tariffPlan.findMany.mockResolvedValue([
      dbPlan('f1', 400),
      { ...dbPlan('f1', 999), id: 'f1-plan-2' },
      dbPlan('f2', 750),
    ])

    const totals = await service.computeTotalsByFacility(['f1', 'f2'], startsAt, endsAt, CAR)

    expect(prisma.tariffPlan.findMany).toHaveBeenCalledTimes(1)
    expect(totals.get('f1')).toBe(800)
    expect(totals.get('f2')).toBe(1500)
  })

  it('omits facilities whose plan has no applicable price', async () => {
    const broken = dbPlan('f2', 0)
    broken.windows[0]!.rates = []
    broken.tiers[0]!.rates = []
    prisma.tariffPlan.findMany.mockResolvedValue([dbPlan('f1', 400), broken])

    const totals = await service.computeTotalsByFacility(['f1', 'f2'], startsAt, endsAt, CAR)

    expect(totals.get('f1')).toBe(800)
    expect(totals.has('f2')).toBe(false)
  })

  it('skips the query for empty ids or a non-positive window', async () => {
    expect((await service.computeTotalsByFacility([], startsAt, endsAt, CAR)).size).toBe(0)
    expect((await service.computeTotalsByFacility(['f1'], endsAt, startsAt, CAR)).size).toBe(0)
    expect(prisma.tariffPlan.findMany).not.toHaveBeenCalled()
  })

  it('filters the query by vehicle type (empty list or matching)', async () => {
    prisma.tariffPlan.findMany.mockResolvedValue([])
    await service.computeTotalsByFacility(['f1'], startsAt, endsAt, CAR)
    const where = prisma.tariffPlan.findMany.mock.calls[0][0].where
    const vehicleClause = where.AND.find(
      (c: { OR?: unknown[] }) =>
        Array.isArray(c.OR) &&
        c.OR.some((o) => typeof o === 'object' && o !== null && 'vehicleTypes' in o),
    )
    expect(vehicleClause).toBeDefined()
  })
})
