import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { ThrottlerStorage } from '@nestjs/throttler'
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis'
import Redis from 'ioredis'

/**
 * Backs @nestjs/throttler with Redis so every API instance shares one counter. The
 * module's default in-memory storage keeps a separate counter per process, which silently
 * multiplies the effective limit by instance count behind a load balancer — the exact gap
 * that let per-route throttles on sign-in/sign-up/password-reset degrade under horizontal
 * scaling. Wraps the community ThrottlerStorageRedisService (atomic Lua increment, same
 * ThrottlerStorage contract) rather than reimplementing it, but owns the connection itself
 * so it follows this codebase's own Redis-URL-parsing convention (see JobsModule,
 * QrReplayCache) instead of the service's own URL/options constructor overload.
 */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage, OnModuleDestroy {
  private readonly logger = new Logger(RedisThrottlerStorage.name)
  private readonly redis: Redis
  private readonly service: ThrottlerStorageRedisService

  constructor(config: ConfigService) {
    const url = new URL(config.get<string>('REDIS_URL') ?? 'redis://localhost:6379')
    this.redis = new Redis({
      host: url.hostname,
      port: Number(url.port || 6379),
      username: url.username || undefined,
      password: url.password || undefined,
    })
    // Same reasoning as QrReplayCache: an EventEmitter with no 'error' listener throws and
    // crashes the process.
    this.redis.on('error', (error: Error) => {
      this.logger.error(`Throttler Redis connection error: ${error.message}`)
    })
    this.service = new ThrottlerStorageRedisService(this.redis)
  }

  increment(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string) {
    return this.service.increment(key, ttl, limit, blockDuration, throttlerName)
  }

  /**
   * Test-only reset seam (see test/utils/throttle.ts): e2e suites share this one Redis
   * instance for the whole run rather than getting it recreated per suite the way the
   * database does, so a tightly-throttled route's hit count otherwise leaks from one spec
   * file into the next. Scoped to the increment script's own key suffixes — every hit/block
   * key it writes is `{<key>:<throttlerName>}:hits` or `...:blocked` — rather than FLUSHDB,
   * so this cannot also wipe the QR-replay cache or BullMQ's job data on the same instance.
   */
  async reset(): Promise<void> {
    const keys: string[] = []
    for (const pattern of ['*}:hits', '*}:blocked']) {
      let cursor = '0'
      do {
        const [next, batch] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100)
        keys.push(...batch)
        cursor = next
      } while (cursor !== '0')
    }
    if (keys.length > 0) await this.redis.del(...keys)
  }

  /**
   * Nest calls every provider's onModuleDestroy in one pass and a throw here aborts the
   * rest of it — observed under the e2e suite's connection churn, where a transient
   * hiccup can leave `this.redis` already 'end' by shutdown time, `quit()` then rejects
   * with "Connection is closed", and PrismaService's own onModuleDestroy (disconnecting
   * its Postgres pool) never runs for that app instance. There is nothing left to close
   * gracefully on an already-closed connection, so this must not propagate that rejection.
   */
  async onModuleDestroy(): Promise<void> {
    if (this.redis.status === 'end') return
    try {
      await this.redis.quit()
    } catch (error) {
      this.logger.warn(`Throttler Redis connection already closing: ${(error as Error).message}`)
    }
  }
}
