import type { PrismaService } from '../prisma/prisma.service'
import { HealthService } from './health.service'
import type { RedisHealthIndicator } from './redis-health.indicator'

function makePrisma(queryRaw: jest.Mock): PrismaService {
  return { $queryRaw: queryRaw } as unknown as PrismaService
}

function makeRedis(checkConnection: jest.Mock): RedisHealthIndicator {
  return { checkConnection } as unknown as RedisHealthIndicator
}

describe('HealthService', () => {
  it('reports ok when both dependencies are healthy', async () => {
    const service = new HealthService(
      makePrisma(jest.fn().mockResolvedValue([{ '?column?': 1 }])),
      makeRedis(jest.fn().mockResolvedValue(undefined)),
    )

    const result = await service.checkReadiness()

    expect(result.status).toBe('ok')
    expect(result.checks.database).toEqual({ status: 'up' })
    expect(result.checks.redis).toEqual({ status: 'up' })
  })

  it('reports a down database without marking redis unhealthy', async () => {
    const service = new HealthService(
      makePrisma(jest.fn().mockRejectedValue(new Error('connection refused'))),
      makeRedis(jest.fn().mockResolvedValue(undefined)),
    )

    const result = await service.checkReadiness()

    expect(result.status).toBe('error')
    expect(result.checks.database).toEqual({ status: 'down', error: 'connection refused' })
    expect(result.checks.redis).toEqual({ status: 'up' })
  })

  it('reports a down redis without marking the database unhealthy', async () => {
    const service = new HealthService(
      makePrisma(jest.fn().mockResolvedValue([{ '?column?': 1 }])),
      makeRedis(jest.fn().mockRejectedValue(new Error('ECONNREFUSED'))),
    )

    const result = await service.checkReadiness()

    expect(result.status).toBe('error')
    expect(result.checks.database).toEqual({ status: 'up' })
    expect(result.checks.redis).toEqual({ status: 'down', error: 'ECONNREFUSED' })
  })
})
