import { TileStatus } from '@prisma/client'
import type { Job } from 'bullmq'
import type { Place } from '@spark/types'
import { GOOGLE_MAX_RESULTS, GOOGLE_MAX_SUBDIVIDE_DEPTH } from './ingestion.constants'
import { GoogleFetchProcessor } from './google.processor'
import type { IngestionService, TileFetchJobData } from './ingestion.service'
import type { MapsService } from '../maps/maps.service'
import type { PrismaService } from '../prisma/prisma.service'

const tile = { south: 37.97, west: 23.71, north: 37.99, east: 23.73 }
const makeJob = (data: TileFetchJobData) => ({ data }) as unknown as Job<TileFetchJobData>

const place = (id: string): Place =>
  ({ placeId: id, coordinates: { lat: 37.98, lng: 23.72 } }) as unknown as Place

const capResults = (): Place[] => Array.from({ length: GOOGLE_MAX_RESULTS }, (_, i) => place(`p${i}`))

describe('GoogleFetchProcessor subdivision', () => {
  let prisma: { rawPlace: { findUnique: jest.Mock; upsert: jest.Mock }; ingestTile: { update: jest.Mock } }
  let maps: { searchPlaces: jest.Mock }
  let ingestion: { enqueueGoogleSubtiles: jest.Mock }
  let processor: GoogleFetchProcessor

  beforeEach(() => {
    prisma = {
      rawPlace: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn().mockResolvedValue({}) },
      ingestTile: { update: jest.fn().mockResolvedValue({}) },
    }
    maps = { searchPlaces: jest.fn() }
    ingestion = { enqueueGoogleSubtiles: jest.fn().mockResolvedValue(undefined) }
    processor = new GoogleFetchProcessor(
      prisma as unknown as PrismaService,
      maps as unknown as MapsService,
      ingestion as unknown as IngestionService,
    )
  })

  const lastTileUpdate = () => prisma.ingestTile.update.mock.calls.at(-1)![0]

  it('subdivides into four quadrant subtiles when a tile hits the result cap', async () => {
    maps.searchPlaces.mockResolvedValue(capResults())

    await processor.process(makeJob({ tileId: 't1', tile }))

    expect(ingestion.enqueueGoogleSubtiles).toHaveBeenCalledTimes(1)
    const [subtiles, depth] = ingestion.enqueueGoogleSubtiles.mock.calls[0]
    expect(subtiles).toHaveLength(4)
    expect(depth).toBe(1)
    // Subtiles enqueued before the parent is marked FETCHED, so the sweep barrier sees them.
    expect(lastTileUpdate().data.status).toBe(TileStatus.FETCHED)
  })

  it('does not subdivide below the cap', async () => {
    maps.searchPlaces.mockResolvedValue([place('a'), place('b')])

    await processor.process(makeJob({ tileId: 't1', tile }))

    expect(ingestion.enqueueGoogleSubtiles).not.toHaveBeenCalled()
  })

  it('accepts truncation at the max depth instead of subdividing forever', async () => {
    maps.searchPlaces.mockResolvedValue(capResults())

    await processor.process(makeJob({ tileId: 't1', tile, depth: GOOGLE_MAX_SUBDIVIDE_DEPTH }))

    expect(ingestion.enqueueGoogleSubtiles).not.toHaveBeenCalled()
    expect(lastTileUpdate().data.status).toBe(TileStatus.FETCHED)
  })
})
