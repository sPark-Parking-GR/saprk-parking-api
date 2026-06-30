import type { Queue } from 'bullmq'
import { IngestionService } from './ingestion.service'
import type { PrismaService } from '../prisma/prisma.service'

describe('IngestionService.enqueueRegion', () => {
  let prisma: { ingestTile: { upsert: jest.Mock } }
  let queue: { add: jest.Mock }
  let googleQueue: { add: jest.Mock }
  let promoteQueue: { add: jest.Mock }
  let service: IngestionService

  beforeEach(() => {
    let counter = 0
    prisma = {
      ingestTile: {
        upsert: jest.fn().mockImplementation(() => Promise.resolve({ id: `tile-${counter++}` })),
      },
    }
    queue = { add: jest.fn().mockResolvedValue(undefined) }
    googleQueue = { add: jest.fn().mockResolvedValue(undefined) }
    promoteQueue = { add: jest.fn().mockResolvedValue(undefined) }
    service = new IngestionService(
      prisma as unknown as PrismaService,
      queue as unknown as Queue,
      googleQueue as unknown as Queue,
      promoteQueue as unknown as Queue,
    )
  })

  it('upserts one tile and enqueues one job for a single-tile region', async () => {
    const result = await service.enqueueRegion({
      south: 37.97,
      west: 23.71,
      north: 37.99,
      east: 23.73,
      tileDegrees: 0.05,
    })

    expect(result.tiles).toBe(1)
    expect(prisma.ingestTile.upsert).toHaveBeenCalledTimes(1)
    expect(queue.add).toHaveBeenCalledTimes(1)

    const [, data, opts] = queue.add.mock.calls[0]
    expect(data.tileId).toBe('tile-0')
    expect(opts.jobId).toBe('osm-tile-0')
    expect(opts.attempts).toBe(3)
  })

  it('tiles a larger region into one job per tile', async () => {
    const result = await service.enqueueRegion({
      south: 37.9,
      west: 23.7,
      north: 38.0,
      east: 23.8,
      tileDegrees: 0.05,
    })

    expect(result.tiles).toBe(4)
    expect(queue.add).toHaveBeenCalledTimes(4)
  })
})
