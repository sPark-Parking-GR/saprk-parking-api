import { createBookingSchema } from './booking.dto'

const baseInput = {
  facilityId: 'f1',
  vehicleType: 'CAR',
  vehiclePlate: 'ABC123',
  sourceChannel: 'MOBILE',
}

describe('createBookingSchema temporal rules', () => {
  it('accepts a short, near-future stay', () => {
    const startsAt = new Date(Date.now() + 60_000)
    const endsAt = new Date(startsAt.getTime() + 2 * 60 * 60_000)

    const result = createBookingSchema.safeParse({ ...baseInput, startsAt, endsAt })

    expect(result.success).toBe(true)
  })

  it('accepts a startsAt slightly backdated within the grace window', () => {
    const startsAt = new Date(Date.now() - 2 * 60_000)
    const endsAt = new Date(startsAt.getTime() + 60 * 60_000)

    const result = createBookingSchema.safeParse({ ...baseInput, startsAt, endsAt })

    expect(result.success).toBe(true)
  })

  it('rejects a startsAt far in the past', () => {
    const startsAt = new Date(Date.now() - 24 * 60 * 60_000)
    const endsAt = new Date(startsAt.getTime() + 60 * 60_000)

    const result = createBookingSchema.safeParse({ ...baseInput, startsAt, endsAt })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('startsAt'))).toBe(true)
    }
  })

  it('rejects a stay exceeding the maximum duration', () => {
    const startsAt = new Date(Date.now() + 60_000)
    const endsAt = new Date(startsAt.getTime() + 366 * 24 * 60 * 60_000)

    const result = createBookingSchema.safeParse({ ...baseInput, startsAt, endsAt })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('endsAt'))).toBe(true)
    }
  })

  it('still rejects endsAt not after startsAt', () => {
    const startsAt = new Date(Date.now() + 60 * 60_000)
    const endsAt = new Date(startsAt.getTime() - 60_000)

    const result = createBookingSchema.safeParse({ ...baseInput, startsAt, endsAt })

    expect(result.success).toBe(false)
  })
})

describe('createBookingSchema account rules', () => {
  const startsAt = new Date(Date.now() + 60_000)
  const endsAt = new Date(startsAt.getTime() + 60 * 60_000)

  it('rejects a body with no sourceChannel rather than defaulting it', () => {
    const result = createBookingSchema.safeParse({
      facilityId: 'f1',
      vehicleType: 'CAR',
      vehiclePlate: 'ABC123',
      startsAt,
      endsAt,
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('sourceChannel'))).toBe(true)
    }
  })

  it('strips guest contact fields so they can never reach the booking row', () => {
    const result = createBookingSchema.safeParse({
      ...baseInput,
      startsAt,
      endsAt,
      guestEmail: 'stranger@example.com',
      guestPhone: '+306900000000',
    })

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).not.toHaveProperty('guestEmail')
      expect(result.data).not.toHaveProperty('guestPhone')
    }
  })
})
