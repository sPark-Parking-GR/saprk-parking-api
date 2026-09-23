// Value-of-time conversion: walking ~5 km/h (~83 m/min) at a ~9 €/h time value
// (~15 cents/min) ⇒ ~0.18 cents per metre. Rounded to 0.15 as a tunable default
// so the cost-sort trades roughly 1 € of price against ~660 m of extra distance.
export const DEFAULT_DISTANCE_COST_CENTS_PER_METER = 0.15

export function generalizedCostCents(
  priceCents: number | null,
  distanceMeters: number,
  costPerMeterCents: number = DEFAULT_DISTANCE_COST_CENTS_PER_METER,
): number {
  if (priceCents == null) return Number.POSITIVE_INFINITY
  return priceCents + distanceMeters * costPerMeterCents
}
