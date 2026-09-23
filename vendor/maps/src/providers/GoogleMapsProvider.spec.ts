import { GoogleMapsProvider } from './GoogleMapsProvider'

const okJson = (body: unknown) =>
  Promise.resolve({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve(body),
  } as Response)

describe('GoogleMapsProvider', () => {
  const provider = new GoogleMapsProvider({ apiKey: 'test-key' })
  let fetchMock: jest.Mock

  beforeEach(() => {
    fetchMock = jest.fn()
    global.fetch = fetchMock as unknown as typeof fetch
  })

  describe('searchPlaces (nearby)', () => {
    it('maps Places v1 results and parses address components', async () => {
      fetchMock.mockReturnValue(
        okJson({
          places: [
            {
              id: 'PLACE_1',
              displayName: { text: 'Syntagma Parking' },
              formattedAddress: 'Mitropoleos 5, Athens 105 63',
              location: { latitude: 37.975, longitude: 23.735 },
              types: ['parking'],
              addressComponents: [
                { longText: 'Mitropoleos', shortText: 'Mitropoleos', types: ['route'] },
                { longText: '5', shortText: '5', types: ['street_number'] },
                { longText: 'Athens', shortText: 'Athens', types: ['locality'] },
                { longText: '105 63', shortText: '105 63', types: ['postal_code'] },
                { longText: 'Greece', shortText: 'GR', types: ['country'] },
              ],
            },
            { id: 'NO_LOC', displayName: { text: 'Bad' } },
          ],
        }),
      )

      const places = await provider.searchPlaces('', {
        location: { lat: 37.98, lng: 23.73 },
        radius: 800,
      })

      expect(places).toHaveLength(1)
      expect(places[0]).toEqual({
        placeId: 'PLACE_1',
        name: 'Syntagma Parking',
        coordinates: { lat: 37.975, lng: 23.735 },
        types: ['parking'],
        address: {
          formattedAddress: 'Mitropoleos 5, Athens 105 63',
          street: 'Mitropoleos',
          streetNumber: '5',
          city: 'Athens',
          region: undefined,
          postalCode: '105 63',
          country: 'Greece',
          countryCode: 'GR',
        },
      })

      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toContain('places:searchNearby')
      expect((init.headers as Record<string, string>)['X-Goog-Api-Key']).toBe('test-key')
      expect(JSON.parse(init.body)).toMatchObject({
        includedTypes: ['parking'],
        locationRestriction: { circle: { radius: 800 } },
      })
    })
  })

  describe('getPlaceDetails', () => {
    it('maps a single place from the details endpoint', async () => {
      fetchMock.mockReturnValue(
        okJson({
          id: 'PLACE_9',
          displayName: { text: 'Garage X' },
          location: { latitude: 37.9, longitude: 23.7 },
          types: ['parking'],
          businessStatus: 'OPERATIONAL',
        }),
      )
      const place = await provider.getPlaceDetails('PLACE_9')
      expect(place?.placeId).toBe('PLACE_9')
      expect(place?.businessStatus).toBe('OPERATIONAL')
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toContain('/places/PLACE_9')
      expect((init.headers as Record<string, string>)['X-Goog-FieldMask']).not.toContain('places.')
    })

    it('returns null when the place is gone (404)', async () => {
      fetchMock.mockReturnValue(
        Promise.resolve({
          ok: false,
          status: 404,
          statusText: 'Not Found',
          text: () => Promise.resolve(''),
        } as Response),
      )
      expect(await provider.getPlaceDetails('GONE')).toBeNull()
    })
  })

  describe('reverseGeocode', () => {
    it('returns the first result with derived confidence', async () => {
      fetchMock.mockReturnValue(
        okJson({
          status: 'OK',
          results: [
            {
              formatted_address: 'Ermou 10, Athens',
              geometry: { location: { lat: 37.97, lng: 23.72 }, location_type: 'ROOFTOP' },
              place_id: 'GEO_1',
              address_components: [{ long_name: 'Greece', short_name: 'GR', types: ['country'] }],
            },
          ],
        }),
      )

      const result = await provider.reverseGeocode({ lat: 37.97, lng: 23.72 })
      expect(result?.confidence).toBe('high')
      expect(result?.placeId).toBe('GEO_1')
      expect(result?.address.countryCode).toBe('GR')
    })

    it('returns null when Google has no results', async () => {
      fetchMock.mockReturnValue(okJson({ status: 'ZERO_RESULTS', results: [] }))
      expect(await provider.reverseGeocode({ lat: 0, lng: 0 })).toBeNull()
    })
  })

  describe('failed request error messages', () => {
    it('does not carry the API key or request URL when Google returns a non-OK status', async () => {
      fetchMock.mockReturnValue(
        Promise.resolve({
          ok: false,
          status: 400,
          statusText: 'Bad Request',
          text: () => Promise.resolve('key=test-key was rejected'),
        } as Response),
      )

      const error: Error = await provider.geocode('1 Main St').catch((e) => e)
      expect(error.message).toBe('Google Maps API request failed: 400 Bad Request')
      expect(error.message).not.toContain('test-key')
    })

    it('replaces a network-level fetch failure with a fixed, secret-free error', async () => {
      fetchMock.mockImplementation(() =>
        Promise.reject(
          new TypeError('Failed to parse URL from https://maps.googleapis.com/x?key=test-key'),
        ),
      )

      const error: Error = await provider.geocode('1 Main St').catch((e) => e)
      expect(error.message).toBe('Google Maps API request failed: network error')
      expect(error.message).not.toContain('test-key')
    })

    it('does not carry the API key when getPlaceDetails fails with a non-OK status', async () => {
      fetchMock.mockReturnValue(
        Promise.resolve({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          text: () => Promise.resolve('unexpected'),
        } as Response),
      )

      const error: Error = await provider.getPlaceDetails('PLACE_1').catch((e) => e)
      expect(error.message).toBe('Google Places details request failed: 500 Internal Server Error')
    })
  })
})
