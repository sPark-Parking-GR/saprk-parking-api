import { z } from 'zod'
import { RateUnit, CapScope } from '@prisma/client'
import { InvalidTariffScheduleError } from '../common/errors/domain.errors'

const tierSchema = z.object({
  id: z.string(),
  fromMinute: z.number().int().min(0),
  toMinute: z.number().int().positive().nullable(),
  unit: z.nativeEnum(RateUnit),
  blockMinutes: z.number().int().positive().nullable(),
})

const windowSchema = z.object({
  id: z.string(),
  label: z.string(),
  dayMask: z.number().int().min(0).max(127),
  startMinute: z.number().int().min(0).max(1439),
  endMinute: z.number().int().min(0).max(1440),
})

const capSchema = z.object({
  windowMinutes: z.number().int().positive(),
  capCents: z.number().int().positive(),
  scope: z.nativeEnum(CapScope),
})

export const scheduleSchema = z.object({
  tiers: z.array(tierSchema).min(1),
  windows: z.array(windowSchema).min(1),
  caps: z.array(capSchema).default([]),
})

export type ScheduleInput = z.infer<typeof scheduleSchema>

const DAY_MINUTES = 1440

function fail(reason: string): never {
  throw new InvalidTariffScheduleError(reason)
}

// Tiers must tile the duration axis contiguously from 0 with no gap/overlap, and
// exactly one open-ended tier (toMinute = null), which must be last.
function validateTiers(tiers: ScheduleInput['tiers']): void {
  const sorted = [...tiers].sort((a, b) => a.fromMinute - b.fromMinute)
  const openEnded = sorted.filter((t) => t.toMinute === null)
  if (openEnded.length !== 1) fail('exactly one open-ended tier required')
  const last = sorted[sorted.length - 1]
  if (!last || last.toMinute !== null) fail('open-ended tier must be last')

  let expected = 0
  for (const tier of sorted) {
    if (tier.fromMinute !== expected) {
      fail(`tier gap/overlap at minute ${expected}`)
    }
    if (tier.toMinute !== null) {
      if (tier.toMinute <= tier.fromMinute) fail('tier toMinute must exceed fromMinute')
      expected = tier.toMinute
    }
    if (tier.unit === RateUnit.PER_BLOCK && !(tier.blockMinutes && tier.blockMinutes > 0)) {
      fail('PER_BLOCK tier requires blockMinutes > 0')
    }
  }
}

// For each weekday the active windows must tile the full 24h with no gap/overlap.
// Wrapping windows ([start,1440) ∪ [0,end)) and all-day windows are expanded into
// minute segments per day, then checked for exact, contiguous coverage.
function validateWindows(windows: ScheduleInput['windows']): void {
  for (let day = 0; day < 7; day += 1) {
    const bit = 1 << day
    const segments: Array<[number, number]> = []
    for (const w of windows) {
      if ((w.dayMask & bit) === 0) continue
      if (w.endMinute > w.startMinute) {
        segments.push([w.startMinute, w.endMinute])
      } else {
        segments.push([w.startMinute, DAY_MINUTES])
        if (w.endMinute > 0) segments.push([0, w.endMinute])
      }
    }
    if (segments.length === 0) fail(`weekday ${day} has no window coverage`)
    segments.sort((a, b) => a[0] - b[0])
    let cursor = 0
    for (const [start, end] of segments) {
      if (start !== cursor) fail(`window gap/overlap on weekday ${day} at minute ${cursor}`)
      cursor = end
    }
    if (cursor !== DAY_MINUTES) fail(`weekday ${day} not covered to end of day`)
  }
}

export function validateSchedule(input: unknown): ScheduleInput {
  const parsed = scheduleSchema.safeParse(input)
  if (!parsed.success) {
    fail(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
  }
  validateTiers(parsed.data.tiers)
  validateWindows(parsed.data.windows)
  return parsed.data
}
