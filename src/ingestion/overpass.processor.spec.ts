import { RawPlaceStatus, TileStatus } from '@prisma/client'
import type { Job } from 'bullmq'
import { createHash } from 'node:crypto'
import { OverpassProcessor } from './overpass.processor'
import type { OverpassClient } from './overpass.client'
import type { TileFetchJobData } from './ingestion.service'
import type { PrismaService } from '../prisma/prisma.service'

const hashOf = (el: unknown) => createHash('sha256').update(JSON.stringify(el)).digest('hex')

const tile = { south: 37.97, west: 23.71, north: 37.99, east: 23.73 }
const makeJob = (data: TileFetchJobData) => ({ data }) as unknown as Job<TileFetchJobData>

describe('OverpassProcessor', () => {
  let prisma: {
    rawPlace: { findUnique: jest.Mock; upsert: jest.Mock }
    ingestTile: { update: jest.Mock }
  }
  let overpass: { fetchParkingTile: jest.Mock }
  let processor: OverpassProcessor

  beforeEach(() => {
    prisma = {
      rawPlace: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
      },
      ingestTile: { update: jest.fn().mockResolvedValue({}) },
    }
    overpass = { fetchParkingTile: jest.fn() }
    processor = new OverpassProcessor(
      prisma as unknown as PrismaService,
      overpass as unknown as OverpassClient,
    )
  })

  const lastTileUpdate = () => prisma.ingestTile.update.mock.calls.at(-1)![0]

  it('stores elements with coordinates and skips those without', async () => {
    overpass.fetchParkingTile.mockResolvedValue({
      elements: [
        { type: 'node', id: 1, lat: 37.98, lon: 23.72, tags: { amenity: 'parking' } },
        { type: 'way', id: 2, center: { lat: 37.985, lon: 23.725 }, tags: { amenity: 'parking' } },
        { type: 'relation', id: 3, tags: { amenity: 'parking' } },
      ],
    })

    await processor.process(makeJob({ tileId: 't1', tile }))

    expect(prisma.rawPlace.upsert).toHaveBeenCalledTimes(2)
    const update = lastTileUpdate()
    expect(update.data.status).toBe(TileStatus.FETCHED)
    expect(update.data.resultCount).toBe(2)
  })

  it('derives lat/lng and sourceRef from a way center', async () => {
    overpass.fetchParkingTile.mockResolvedValue({
      elements: [{ type: 'way', id: 2, center: { lat: 37.985, lon: 23.725 } }],
    })

    await processor.process(makeJob({ tileId: 't1', tile }))

    const { create } = prisma.rawPlace.upsert.mock.calls[0][0]
    expect(create.lat).toBe(37.985)
    expect(create.lng).toBe(23.725)
    expect(create.sourceRef).toBe('way/2')
    expect(create.sourceType).toBe('way')
    expect(create.status).toBe(RawPlaceStatus.PENDING)
  })

  it('skips upsert when the contentHash is unchanged', async () => {
    const el = { type: 'node', id: 1, lat: 37.98, lon: 23.72 }
    prisma.rawPlace.findUnique.mockResolvedValue({ contentHash: hashOf(el) })
    overpass.fetchParkingTile.mockResolvedValue({ elements: [el] })

    await processor.process(makeJob({ tileId: 't1', tile }))

    expect(prisma.rawPlace.upsert).not.toHaveBeenCalled()
    expect(lastTileUpdate().data.resultCount).toBe(0)
  })

  it('marks the tile FAILED and rethrows on a fetch error', async () => {
    overpass.fetchParkingTile.mockRejectedValue(new Error('Overpass responded 429 Too Many Requests'))

    await expect(processor.process(makeJob({ tileId: 't1', tile }))).rejects.toThrow('429')

    const update = lastTileUpdate()
    expect(update.data.status).toBe(TileStatus.FAILED)
    expect(update.data.lastError).toContain('429')
  })
})
