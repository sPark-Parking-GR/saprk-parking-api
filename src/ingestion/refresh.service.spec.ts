import type { Place } from '@spark/types'
import type { Queue } from 'bullmq'
import { RefreshService } from './refresh.service'
import type { MapsService } from '../maps/maps.service'
import type { PrismaService } from '../prisma/prisma.service'

const place = (over: Partial<Place> = {}): Place => ({
  placeId: 'P1',
  name: 'New Name',
  address: { formattedAddress: 'New Addr', city: '', country: '', countryCode: '' },
  coordinates: { lat: 1, lng: 2 },
  types: ['parking'],
  openingHours: { periods: [{ open: { day: 0, hour: 0, minute: 0 } }] },
  ...over,
})

describe('RefreshService.refreshStale', () => {
  let prisma: {
    facility: { findMany: jest.Mock; update: jest.Mock; count: jest.Mock }
    $transaction: jest.Mock
  }
  let tx: { facility: { update: jest.Mock }; facilityRule: { upsert: jest.Mock } }
  let maps: { getPlaceDetails: jest.Mock }
  let service: RefreshService

  beforeEach(() => {
    tx = {
      facility: { update: jest.fn().mockResolvedValue({}) },
      facilityRule: { upsert: jest.fn().mockResolvedValue({}) },
    }
    prisma = {
      facility: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([{ id: 'f1', googlePlaceId: 'P1', amenities: ['covered'] }])
          .mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
        count: jest.fn().mockResolvedValue(0),
      },
      $transaction: jest.fn().mockImplementation((cb: (t: typeof tx) => unknown) => cb(tx)),
    }
    maps = { getPlaceDetails: jest.fn() }
    service = new RefreshService(
      prisma as unknown as PrismaService,
      maps as unknown as MapsService,
      {} as unknown as Queue,
    )
  })

  it('refreshes Google display fields and stamps googleSyncedAt', async () => {
    maps.getPlaceDetails.mockResolvedValue(place())

    const stats = await service.refreshStale()

    expect(stats).toEqual({ refreshed: 1, notFound: 0 })
    const data = tx.facility.update.mock.calls[0][0].data
    expect(data.name).toBe('New Name')
    expect(data.address).toBe('New Addr')
    expect(data.openingHoursJson).toEqual({ is24h: true })
    expect(data.amenities.sort()).toEqual(['24h_access', 'covered'])
    expect(data.kind).toBe('BUSINESS')
    expect(data.googleSyncedAt).toBeInstanceOf(Date)
  })

  it('stamps but does not overwrite cached fields when the place is gone', async () => {
    maps.getPlaceDetails.mockResolvedValue(null)

    const stats = await service.refreshStale()

    expect(stats).toEqual({ refreshed: 0, notFound: 1 })
    expect(tx.facility.update).not.toHaveBeenCalled()
    const data = prisma.facility.update.mock.calls[0][0].data
    expect(Object.keys(data)).toEqual(['googleSyncedAt'])
  })
})
