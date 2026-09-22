import {
  MAX_RANGE_DAYS,
  analyticsSummarySchema,
  revenueSeriesSchema,
  topFacilitiesSchema,
} from './analytics.dto'

const DAY_MS = 24 * 60 * 60 * 1_000
const from = '2026-07-01T00:00:00.000Z'

const plusDays = (days: number) => new Date(Date.parse(from) + days * DAY_MS).toISOString()

describe('analytics range validation', () => {
  it('coerces query strings into dates', () => {
    const parsed = analyticsSummarySchema.parse({ from, to: plusDays(30) })
    expect(parsed.from).toEqual(new Date(from))
    expect(parsed.to).toEqual(new Date(plusDays(30)))
  })

  it('rejects an inverted range', () => {
    const result = analyticsSummarySchema.safeParse({ from, to: plusDays(-1) })
    expect(result.success).toBe(false)
  })

  it('rejects a zero-length range', () => {
    expect(analyticsSummarySchema.safeParse({ from, to: from }).success).toBe(false)
  })

  it(`rejects a range longer than ${MAX_RANGE_DAYS} days`, () => {
    const result = analyticsSummarySchema.safeParse({ from, to: plusDays(MAX_RANGE_DAYS + 1) })
    expect(result.success).toBe(false)
    expect(result.success ? [] : result.error.issues.map((i) => i.message)).toContain(
      `range must not exceed ${MAX_RANGE_DAYS} days`,
    )
  })

  it(`accepts a range of exactly ${MAX_RANGE_DAYS} days`, () => {
    expect(analyticsSummarySchema.safeParse({ from, to: plusDays(MAX_RANGE_DAYS) }).success).toBe(
      true,
    )
  })

  it('bounds the series bucket to the three supported units', () => {
    expect(revenueSeriesSchema.parse({ from, to: plusDays(7) }).bucket).toBe('day')
    expect(revenueSeriesSchema.parse({ from, to: plusDays(7), bucket: 'month' }).bucket).toBe(
      'month',
    )
    expect(revenueSeriesSchema.safeParse({ from, to: plusDays(7), bucket: 'hour' }).success).toBe(
      false,
    )
  })

  it('carries the range rules into every endpoint schema', () => {
    const tooLong = { from, to: plusDays(MAX_RANGE_DAYS + 1) }
    expect(revenueSeriesSchema.safeParse(tooLong).success).toBe(false)
    expect(topFacilitiesSchema.safeParse(tooLong).success).toBe(false)
  })

  it('bounds the top-facilities limit', () => {
    expect(topFacilitiesSchema.parse({ from, to: plusDays(7) }).limit).toBe(10)
    expect(topFacilitiesSchema.parse({ from, to: plusDays(7), limit: '5' }).limit).toBe(5)
    expect(topFacilitiesSchema.safeParse({ from, to: plusDays(7), limit: 500 }).success).toBe(false)
    expect(topFacilitiesSchema.safeParse({ from, to: plusDays(7), limit: 0 }).success).toBe(false)
  })
})
