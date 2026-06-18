import { DateTime } from 'luxon'
import { RateUnit, CapScope } from '@prisma/client'
import { NoApplicableTariffError } from '../common/errors/domain.errors'
import type {
  CompiledCap,
  CompiledPlan,
  CompiledTier,
  CompiledWindow,
  PriceResult,
  QuoteLineItem,
} from './tariff.types'

export function ceilDiv(numerator: number, denominator: number): number {
  return Math.ceil(numerator / denominator)
}

export function ceilToIncrement(minutes: number, increment: number): number {
  if (increment <= 1) return minutes
  return Math.ceil(minutes / increment) * increment
}

function tierAt(tiers: CompiledTier[], cursor: number): CompiledTier | undefined {
  return tiers.find(
    (t) => cursor >= t.fromMinute && (t.toMinute === null || cursor < t.toMinute),
  )
}

// A wall-clock minute falls in a window when its weekday bit is set in dayMask and
// its minute-of-day is inside [start,end). When end <= start the window wraps past
// midnight, so the inside test becomes the union of [start,1440) and [0,end).
export function windowAt(windows: CompiledWindow[], wall: DateTime): CompiledWindow | undefined {
  const minuteOfDay = wall.hour * 60 + wall.minute
  const weekdayBit = wall.weekday - 1
  return windows.find((w) => {
    if ((w.dayMask & (1 << weekdayBit)) === 0) return false
    if (w.endMinute > w.startMinute) {
      return minuteOfDay >= w.startMinute && minuteOfDay < w.endMinute
    }
    return minuteOfDay >= w.startMinute || minuteOfDay < w.endMinute
  })
}

interface RawCharge {
  durationStart: number
  durationMinutes: number
  tierId: string
  windowId: string
  label: string
  unitPriceCents: number
  quantity: number
  subtotalCents: number
}

// Block-straddling rule: a PER_BLOCK / FLAT charge is priced by the window active at
// its START instant; only PER_MINUTE tiers re-evaluate the window every minute (exact).
export function priceStay(
  startsAt: Date,
  endsAt: Date,
  plan: CompiledPlan,
): PriceResult {
  const rawMinutes = Math.max(0, ceilDiv(endsAt.getTime() - startsAt.getTime(), 60_000))
  const billable = ceilToIncrement(
    Math.max(0, rawMinutes - plan.graceMinutes),
    plan.incrementMinutes,
  )

  if (billable === 0) {
    return { lineItems: [], totalCents: 0, billableMinutes: 0 }
  }

  const base = DateTime.fromJSDate(startsAt, { zone: 'utc' }).setZone(plan.timezone)
  const charges: RawCharge[] = []

  let cursor = 0
  while (cursor < billable) {
    const tier = tierAt(plan.tiers, cursor)
    if (!tier) throw new NoApplicableTariffError(plan.id)

    const tierEnd = tier.toMinute ?? billable
    let block: number
    if (tier.unit === RateUnit.FLAT) {
      block = tierEnd - tier.fromMinute
    } else if (tier.unit === RateUnit.PER_BLOCK) {
      block = tier.blockMinutes ?? 0
      if (block <= 0) throw new NoApplicableTariffError(plan.id)
    } else {
      block = 1
    }

    const span = Math.min(block, billable - cursor, tierEnd - cursor)
    if (span <= 0) throw new NoApplicableTariffError(plan.id)

    const wall = base.plus({ minutes: cursor })
    const window = windowAt(plan.windows, wall)
    if (!window) throw new NoApplicableTariffError(plan.id)

    const rate = plan.price(tier.id, window.id)
    if (rate === undefined) throw new NoApplicableTariffError(plan.id)

    let subtotal: number
    let quantity: number
    if (tier.unit === RateUnit.PER_MINUTE) {
      quantity = span
      subtotal = span * rate
    } else {
      quantity = 1
      subtotal = rate
    }

    charges.push({
      durationStart: cursor,
      durationMinutes: span,
      tierId: tier.id,
      windowId: window.id,
      label: window.label,
      unitPriceCents: rate,
      quantity,
      subtotalCents: subtotal,
    })

    cursor += tier.unit === RateUnit.FLAT ? tierEnd - cursor : span
  }

  const rawTotal = charges.reduce((sum, c) => sum + c.subtotalCents, 0)
  const total = applyCaps(rawTotal, charges, plan.caps)

  const lineItems = coalesce(charges)
  if (total !== rawTotal) {
    lineItems.push({
      label: 'Cap adjustment',
      durationMinutes: billable,
      unitPriceCents: 0,
      quantity: 1,
      subtotalCents: total - rawTotal,
    })
  }

  return { lineItems, totalCents: total, billableMinutes: billable }
}

// STAY caps clamp the whole-stay total. ROLLING caps clamp each fixed-width duration
// bucket independently, then sum. With multiple caps we take the tightest resulting
// total — an approximation when caps overlap, but the common case is a single daily
// cap, which is exact.
function applyCaps(rawTotal: number, charges: RawCharge[], caps: CompiledCap[]): number {
  let total = rawTotal
  for (const cap of caps) {
    let capped: number
    if (cap.scope === CapScope.STAY) {
      capped = Math.min(rawTotal, cap.capCents)
    } else {
      const buckets = new Map<number, number>()
      for (const c of charges) {
        const bucket = Math.floor(c.durationStart / cap.windowMinutes)
        buckets.set(bucket, (buckets.get(bucket) ?? 0) + c.subtotalCents)
      }
      capped = 0
      for (const sum of buckets.values()) {
        capped += Math.min(sum, cap.capCents)
      }
    }
    total = Math.min(total, capped)
  }
  return total
}

function coalesce(charges: RawCharge[]): QuoteLineItem[] {
  const byCell = new Map<string, QuoteLineItem>()
  const order: string[] = []
  for (const c of charges) {
    const key = `${c.tierId}|${c.windowId}`
    const existing = byCell.get(key)
    if (existing) {
      existing.durationMinutes += c.durationMinutes
      existing.quantity += c.quantity
      existing.subtotalCents += c.subtotalCents
    } else {
      byCell.set(key, {
        label: c.label,
        durationMinutes: c.durationMinutes,
        unitPriceCents: c.unitPriceCents,
        quantity: c.quantity,
        subtotalCents: c.subtotalCents,
      })
      order.push(key)
    }
  }
  return order.map((k) => byCell.get(k) as QuoteLineItem)
}
