import { DEFAULT_DISTANCE_COST_CENTS_PER_METER, generalizedCostCents } from './generalizedCost'

describe('generalizedCostCents', () => {
  it('adds the distance cost to the price', () => {
    expect(generalizedCostCents(500, 1000, 0.15)).toBe(650)
  })

  it('uses the default coefficient when none is given', () => {
    expect(generalizedCostCents(0, 1000)).toBe(1000 * DEFAULT_DISTANCE_COST_CENTS_PER_METER)
  })

  it('returns infinity when the price is unknown so unpriced spots sort last', () => {
    expect(generalizedCostCents(null, 100)).toBe(Number.POSITIVE_INFINITY)
  })

  it('ranks a cheaper spot ahead when the price saving beats the added distance cost', () => {
    const near = generalizedCostCents(700, 200) // 700 + 30 = 730
    const far = generalizedCostCents(500, 1500) // 500 + 225 = 725
    expect(far).toBeLessThan(near)
  })

  it('two unpriced spots tie at infinity so a downstream distance tiebreak applies', () => {
    expect(generalizedCostCents(null, 100)).toBe(generalizedCostCents(null, 9000))
  })
})
