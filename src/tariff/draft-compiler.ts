import type { RateUnit, CapScope } from '@prisma/client'
import type { CompiledPlan } from './tariff.types'

export interface DraftTier {
  key: string
  fromMinute: number
  toMinute: number | null
  unit: RateUnit
  blockMinutes: number | null
}

export interface DraftWindow {
  key: string
  label: string
  dayMask: number
  startMinute: number
  endMinute: number
}

export interface DraftRate {
  tierKey: string
  windowKey: string
  priceCents: number
  currency: string
}

export interface DraftCap {
  windowMinutes: number
  capCents: number
  scope: CapScope
}

export interface CompilableDraft {
  timezone: string
  graceMinutes: number
  incrementMinutes: number
  tiers: DraftTier[]
  windows: DraftWindow[]
  rates: DraftRate[]
  caps: DraftCap[]
}

// Mirrors TariffService.compilePlan but sources an in-memory draft whose tier/window
// keys stand in as ids: the price lookup keys on (tierKey,windowKey) and the currency
// falls back to the first rate, then 'EUR'. Used by the simulate path to price an
// unsaved plan without persisting anything.
export function compileDraft(draft: CompilableDraft): CompiledPlan {
  const prices = new Map<string, number>()
  for (const rate of draft.rates) {
    prices.set(`${rate.tierKey}|${rate.windowKey}`, rate.priceCents)
  }

  const currency = draft.rates[0]?.currency ?? 'EUR'

  return {
    id: 'draft',
    version: 0,
    timezone: draft.timezone,
    graceMinutes: draft.graceMinutes,
    incrementMinutes: draft.incrementMinutes,
    currency,
    tiers: draft.tiers.map((t) => ({
      id: t.key,
      fromMinute: t.fromMinute,
      toMinute: t.toMinute,
      unit: t.unit,
      blockMinutes: t.blockMinutes,
    })),
    windows: draft.windows.map((w) => ({
      id: w.key,
      label: w.label,
      dayMask: w.dayMask,
      startMinute: w.startMinute,
      endMinute: w.endMinute,
    })),
    caps: draft.caps.map((c) => ({
      windowMinutes: c.windowMinutes,
      capCents: c.capCents,
      scope: c.scope,
    })),
    price: (tierId, windowId) => prices.get(`${tierId}|${windowId}`),
  }
}
