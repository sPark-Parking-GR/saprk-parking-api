import { FacilityKind, VehicleType } from '@prisma/client'
import { normalizeOsm } from './osm-normalizer'

const base = { sourceRef: 'node/1', lat: 37.98, lng: 23.72 }

describe('normalizeOsm', () => {
  describe('name', () => {
    it('prefers the explicit name tag', () => {
      expect(normalizeOsm({ ...base, tags: { name: 'Syntagma Garage' } }).name).toBe(
        'Syntagma Garage',
      )
    })

    it('falls back to localized name then operator', () => {
      expect(normalizeOsm({ ...base, tags: { 'name:el': 'Στάθμευση' } }).name).toBe('Στάθμευση')
      expect(normalizeOsm({ ...base, tags: { operator: 'Acme Parking' } }).name).toBe(
        'Acme Parking',
      )
    })

    it('synthesizes a name from the parking type when unnamed', () => {
      expect(normalizeOsm({ ...base, tags: { parking: 'underground' } }).name).toBe(
        'Underground parking',
      )
      expect(normalizeOsm({ ...base, tags: {} }).name).toBe('Parking')
    })
  })

  describe('address', () => {
    it('assembles street, number, postcode and city', () => {
      const out = normalizeOsm({
        ...base,
        tags: {
          'addr:street': 'Ermou',
          'addr:housenumber': '5',
          'addr:postcode': '10563',
          'addr:city': 'Athens',
        },
      })
      expect(out.address).toBe('Ermou 5, 10563 Athens')
    })

    it('is empty when no address tags exist', () => {
      expect(normalizeOsm({ ...base, tags: {} }).address).toBe('')
    })
  })

  describe('capacity', () => {
    it('parses a numeric capacity', () => {
      expect(normalizeOsm({ ...base, tags: { capacity: '120' } }).totalCapacity).toBe(120)
    })

    it('defaults to 0 for missing or non-numeric capacity', () => {
      expect(normalizeOsm({ ...base, tags: {} }).totalCapacity).toBe(0)
      expect(normalizeOsm({ ...base, tags: { capacity: 'yes' } }).totalCapacity).toBe(0)
    })
  })

  describe('height', () => {
    it('converts metres to centimetres', () => {
      expect(normalizeOsm({ ...base, tags: { maxheight: '2.1' } }).heightRestrictionCm).toBe(210)
      expect(normalizeOsm({ ...base, tags: { maxheight: '2.10 m' } }).heightRestrictionCm).toBe(210)
    })

    it('rejects out-of-range or unparseable heights', () => {
      expect(
        normalizeOsm({ ...base, tags: { maxheight: 'default' } }).heightRestrictionCm,
      ).toBeNull()
      expect(normalizeOsm({ ...base, tags: { maxheight: '0.2' } }).heightRestrictionCm).toBeNull()
      expect(normalizeOsm({ ...base, tags: {} }).heightRestrictionCm).toBeNull()
    })
  })

  describe('opening hours', () => {
    it('maps 24/7 to is24h', () => {
      expect(normalizeOsm({ ...base, tags: { opening_hours: '24/7' } }).openingHours).toEqual({
        is24h: true,
      })
    })

    it('leaves structured hours unparsed (is24h false)', () => {
      expect(
        normalizeOsm({ ...base, tags: { opening_hours: 'Mo-Fr 08:00-20:00' } }).openingHours,
      ).toEqual({
        is24h: false,
      })
    })
  })

  describe('amenities', () => {
    it('maps tags to amenity flags', () => {
      const out = normalizeOsm({
        ...base,
        tags: {
          parking: 'underground',
          wheelchair: 'yes',
          supervised: 'yes',
          park_ride: 'yes',
          fee: 'no',
          opening_hours: '24/7',
        },
      })
      expect(out.amenities.sort()).toEqual(
        ['24h_access', 'covered', 'disabled_spaces', 'cctv', 'park_ride', 'free'].sort(),
      )
    })

    it('emits no amenity flags for a bare surface lot', () => {
      expect(normalizeOsm({ ...base, tags: { parking: 'surface' } }).amenities).toEqual([])
    })
  })

  describe('access', () => {
    it('classifies access', () => {
      expect(normalizeOsm({ ...base, tags: { access: 'private' } }).access).toBe('private')
      expect(normalizeOsm({ ...base, tags: { access: 'customers' } }).access).toBe('customers')
      expect(normalizeOsm({ ...base, tags: { access: 'yes' } }).access).toBe('public')
      expect(normalizeOsm({ ...base, tags: {} }).access).toBe('public')
    })
  })

  describe('kind classification', () => {
    it('classifies a restricted-access lot as RESTRICTED regardless of fee', () => {
      expect(normalizeOsm({ ...base, tags: { access: 'private', fee: 'yes' } }).kind).toBe(
        FacilityKind.RESTRICTED,
      )
      expect(normalizeOsm({ ...base, tags: { access: 'customers' } }).kind).toBe(
        FacilityKind.RESTRICTED,
      )
      expect(normalizeOsm({ ...base, tags: { access: 'permit' } }).kind).toBe(
        FacilityKind.RESTRICTED,
      )
    })

    it('classifies a paid lot as BUSINESS', () => {
      expect(normalizeOsm({ ...base, tags: { fee: 'yes' } }).kind).toBe(FacilityKind.BUSINESS)
    })

    it('classifies a covered/built parking structure as BUSINESS', () => {
      expect(normalizeOsm({ ...base, tags: { parking: 'underground' } }).kind).toBe(
        FacilityKind.BUSINESS,
      )
      expect(normalizeOsm({ ...base, tags: { parking: 'multi-storey' } }).kind).toBe(
        FacilityKind.BUSINESS,
      )
      expect(normalizeOsm({ ...base, tags: { parking: 'garage' } }).kind).toBe(
        FacilityKind.BUSINESS,
      )
    })

    it('classifies free and on-street lots as FREE_PUBLIC', () => {
      expect(normalizeOsm({ ...base, tags: { fee: 'no' } }).kind).toBe(FacilityKind.FREE_PUBLIC)
      expect(normalizeOsm({ ...base, tags: { parking: 'street_side' } }).kind).toBe(
        FacilityKind.FREE_PUBLIC,
      )
      expect(normalizeOsm({ ...base, tags: { parking: 'lane' } }).kind).toBe(
        FacilityKind.FREE_PUBLIC,
      )
    })

    it('leaves an untagged surface lot UNKNOWN for review', () => {
      expect(normalizeOsm({ ...base, tags: { parking: 'surface' } }).kind).toBe(
        FacilityKind.UNKNOWN,
      )
      expect(normalizeOsm({ ...base, tags: {} }).kind).toBe(FacilityKind.UNKNOWN)
    })
  })

  describe('rules and defaults', () => {
    it('captures present OSM tags as provenance rules', () => {
      const out = normalizeOsm({
        ...base,
        tags: { parking: 'surface', fee: 'yes', surface: 'asphalt' },
      })
      expect(out.rules).toEqual([
        { ruleKey: 'osm:parking', ruleValue: 'surface' },
        { ruleKey: 'osm:fee', ruleValue: 'yes' },
        { ruleKey: 'osm:surface', ruleValue: 'asphalt' },
      ])
    })

    it('always defaults vehicleTypes to CAR and carries coordinates through', () => {
      const out = normalizeOsm({ ...base, tags: {} })
      expect(out.vehicleTypes).toEqual([VehicleType.CAR])
      expect(out.lat).toBe(37.98)
      expect(out.lng).toBe(23.72)
      expect(out.sourceRef).toBe('node/1')
    })
  })
})
