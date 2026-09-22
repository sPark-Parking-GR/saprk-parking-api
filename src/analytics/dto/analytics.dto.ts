import { z } from 'zod'

// An aggregate over every payment an operator has ever taken is the cheapest denial of
// service in the API, so the window is bounded at the request boundary. 366 days matches
// the pricing engine's own stay ceiling and covers the longest range a dashboard offers
// (a full year, leap year included); anything wider is a reporting export, not a panel.
export const MAX_RANGE_DAYS = 366
const MAX_RANGE_MS = MAX_RANGE_DAYS * 24 * 60 * 60 * 1_000

export const REVENUE_BUCKETS = ['day', 'week', 'month'] as const
export type RevenueBucket = (typeof REVENUE_BUCKETS)[number]

const rangeShape = {
  from: z.coerce.date(),
  // Exclusive: `to` is the first instant NOT reported on, so consecutive ranges tile
  // without double-counting a payment that lands exactly on a boundary.
  to: z.coerce.date(),
  // Only a platform admin may name an arbitrary operator. An operator caller may name one
  // of their own; the service rejects anything else (see AnalyticsService).
  operatorId: z.string().min(1).optional(),
}

function withRangeRules<Output extends { from: Date; to: Date }, Input>(
  schema: z.ZodType<Output, z.ZodTypeDef, Input>,
) {
  return schema
    .refine((q) => q.to > q.from, { message: 'to must be after from', path: ['to'] })
    .refine((q) => q.to.getTime() - q.from.getTime() <= MAX_RANGE_MS, {
      message: `range must not exceed ${MAX_RANGE_DAYS} days`,
      path: ['to'],
    })
}

export const analyticsSummarySchema = withRangeRules(z.object(rangeShape))
export type AnalyticsSummaryDto = z.infer<typeof analyticsSummarySchema>

export const revenueSeriesSchema = withRangeRules(
  z.object({ ...rangeShape, bucket: z.enum(REVENUE_BUCKETS).default('day') }),
)
export type RevenueSeriesDto = z.infer<typeof revenueSeriesSchema>

export const topFacilitiesSchema = withRangeRules(
  z.object({
    ...rangeShape,
    limit: z.coerce.number().int().positive().max(50).default(10),
  }),
)
export type TopFacilitiesDto = z.infer<typeof topFacilitiesSchema>
