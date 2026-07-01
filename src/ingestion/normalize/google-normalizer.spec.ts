import { FacilityKind, IngestSource, VehicleType } from '@prisma/client'
import type { Place } from '@spark/types'
import { normalizeGoogle } from './google-normalizer'

const basePlace = (over: Partial<Place> = {}): Place => ({
  placeId: 'PLACE_1',
  name: 'Syntagma Parking',
  address: {
    formattedAddress: 'Mitropoleos 5, Athens',
    city: 'Athens',
    country: 'Greece',
    countryCode: 'GR',
  },
  coordinates: { lat: 37.975, lng: 23.735 },
  types: ['parking'],
  ...over,
})

describe('normalizeGoogle', () => {
  it('maps core fields with catalog defaults', () => {
    const out = normalizeGoogle(basePlace())
    expect(out.source).toBe(IngestSource.GOOGLE)
    expect(out.sourceRef).toBe('PLACE_1')
    expect(out.name).toBe('Syntagma Parking')
    expect(out.address).toBe('Mitropoleos 5, Athens')
    expect(out.lat).toBe(37.975)
    expect(out.totalCapacity).toBe(0)
    expect(out.heightRestrictionCm).toBeNull()
    expect(out.vehicleTypes).toEqual([VehicleType.CAR])
    expect(out.kind).toBe(FacilityKind.BUSINESS)
  })

  describe('opening hours', () => {
    it('detects 24/7 (single open period, no close)', () => {
      const out = normalizeGoogle(
        basePlace({ openingHours: { periods: [{ open: { day: 0, hour: 0, minute: 0 } }] } }),
      )
      expect(out.openingHours).toEqual({ is24h: true })
      expect(out.amenities).toContain('24h_access')
    })

    it('converts weekly periods to a day-keyed schedule, including overnight close', () => {
      const out = normalizeGoogle(
        basePlace({
          openingHours: {
            periods: [
              { open: { day: 1, hour: 6, minute: 0 }, close: { day: 2, hour: 3, minute: 30 } },
              { open: { day: 6, hour: 8, minute: 0 }, close: { day: 6, hour: 22, minute: 0 } },
            ],
          },
        }),
      )
      expect(out.openingHours.is24h).toBe(false)
      expect(out.openingHours.schedule).toEqual({
        monday: { open: '06:00', close: '03:30' },
        saturday: { open: '08:00', close: '22:00' },
      })
    })

    it('returns is24h false when no hours are present', () => {
      expect(normalizeGoogle(basePlace()).openingHours).toEqual({ is24h: false })
    })
  })

  it('maps parking_garage to a covered amenity', () => {
    const out = normalizeGoogle(basePlace({ types: ['parking', 'parking_garage'] }))
    expect(out.amenities).toContain('covered')
  })

  it('captures place id, business status and types as provenance rules', () => {
    const out = normalizeGoogle(basePlace({ businessStatus: 'OPERATIONAL', types: ['parking', 'establishment'] }))
    expect(out.rules).toEqual([
      { ruleKey: 'google:place_id', ruleValue: 'PLACE_1' },
      { ruleKey: 'google:business_status', ruleValue: 'OPERATIONAL' },
      { ruleKey: 'google:types', ruleValue: 'parking,establishment' },
    ])
  })
})
