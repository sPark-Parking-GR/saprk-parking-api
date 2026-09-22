import { DateTime } from 'luxon'
import { RateUnit, CapScope } from '@prisma/client'
import { InvalidTariffScheduleError, NoApplicableTariffError } from '../common/errors/domain.errors'
import type {
  CompiledCap,
  CompiledPlan,
  CompiledTier,
  CompiledWindow,
  PriceResult,
  QuoteLineItem,
} from './tariff.types'

const MAX_BILLABLE_MINUTES = 366 * 24 * 60

export function ceilDiv(numerator: number, denominator: number): number {
  return Math.ceil(numerator / denominator)
}

export function ceilToIncrement(minutes: number, increment: number): number {
  if (increment <= 1) return minutes
  return Math.ceil(minutes / increment) * increment
}

function tierAt(tiers: CompiledTier[], cursor: number): CompiledTier | undefined {
  return tiers.find((t) => cursor >= t.fromMinute && (t.toMinute === null || cursor < t.toMinute))
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

// The platform's take, in integer cents of the stay total. Basis points because a
// percentage cannot express the quarter-point differences plan tiers are sold on.
//
// Rounded rather than floored or ceiled: the split is between the platform and the operator
// and neither side should be systematically favoured by the half-cent, which floor and ceil
// both are. What the DRIVER pays is untouched either way — commission comes out of the
// total, it is never added to it — so no rounding here can make a stay cost more.
export function commissionOn(totalCents: number, commissionBps: number): number {
  return Math.round((totalCents * commissionBps) / 10_000)
}

// A subscribed rider's perk, in integer cents off the stay total. Unlike commission this
// DOES change what the driver pays, which is why it is a visible line item rather than a
// bookkeeping figure.
//
// Rounded like commission, and then clamped to the total: a 100% discount must land on
// exactly zero and never below it, or a stay would owe the rider money.
export function discountOn(totalCents: number, bookingDiscountBps: number | null): number {
  if (!bookingDiscountBps || totalCents <= 0) return 0
  return Math.min(totalCents, Math.round((totalCents * bookingDiscountBps) / 10_000))
}

// Block-straddling rule: a PER_BLOCK / FLAT charge is priced by the window active at
// its START instant; only PER_MINUTE tiers re-evaluate the window every minute (exact).
//
// commissionBps is required rather than defaulted: a caller that forgets it would silently
// price the platform's take at zero on a real booking, and no test would notice. The
// pure-schedule callers — plan simulation and the map's bulk totals — pass 0 explicitly,
// which is the honest statement that neither prices a stay anyone is billed for.
//
// bookingDiscountBps is required for the identical reason, and the failure direction is
// worse: a forgotten default would quietly charge a subscribed rider full price for a perk
// they are paying a monthly fee to hold. `null` is the honest value where no rider is
// identified — the unauthenticated quote preview, plan simulation, the map's bulk totals —
// and is distinct from a real 0 bps only in intent, never in outcome.
export function priceStay(
  startsAt: Date,
  endsAt: Date,
  plan: CompiledPlan,
  commissionBps: number,
  bookingDiscountBps: number | null,
): PriceResult {
  const rawMinutes = Math.max(0, ceilDiv(endsAt.getTime() - startsAt.getTime(), 60_000))
  const billable = ceilToIncrement(
    Math.max(0, rawMinutes - plan.graceMinutes),
    plan.incrementMinutes,
  )

  // PER_MINUTE tiers advance the pricing loop one minute at a time, so an unbounded
  // span (e.g. a multi-year simulate request) is a CPU-DoS vector. Cap to a year.
  if (billable > MAX_BILLABLE_MINUTES) {
    throw new InvalidTariffScheduleError('stay span exceeds the maximum priceable duration')
  }

  if (billable === 0) {
    return {
      lineItems: [],
      totalCents: 0,
      billableMinutes: 0,
      discountCents: 0,
      commissionBps,
      commissionCents: 0,
    }
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
  const capped = applyCaps(rawTotal, charges, plan.caps)

  // After caps, before commission. Both halves of that order matter: discounting the
  // pre-cap total would hand a capped stay a discount larger than the cap ever charged for,
  // and taking commission before the discount would bill the operator a share of money the
  // platform chose to give away.
  const discountCents = discountOn(capped, bookingDiscountBps)
  const total = capped - discountCents

  const lineItems = coalesce(charges)
  if (capped !== rawTotal) {
    lineItems.push({
      label: 'Cap adjustment',
      durationMinutes: billable,
      unitPriceCents: 0,
      quantity: 1,
      subtotalCents: capped - rawTotal,
    })
  }
  // Its own negative line item, following the cap adjustment's pattern: a rider paying for a
  // plan has to be able to SEE the perk applied, and a total that is simply smaller than the
  // schedule implies looks like a pricing bug rather than a benefit.
  if (discountCents > 0) {
    lineItems.push({
      label: 'Subscription discount',
      durationMinutes: billable,
      unitPriceCents: 0,
      quantity: 1,
      subtotalCents: -discountCents,
    })
  }

  // Commission is a share of what is actually charged, so a capped or discounted stay that
  // took less money owes the platform proportionally less.
  return {
    lineItems,
    totalCents: total,
    billableMinutes: billable,
    discountCents,
    commissionBps,
    commissionCents: commissionOn(total, commissionBps),
  }
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
