import type { INestApplication } from '@nestjs/common'
import { RedisThrottlerStorage } from '../../src/throttler/redis-throttler-storage'

/**
 * Rate limits are keyed by (client IP, handler) and every request in a suite arrives from
 * the same loopback address, so a suite that exercises one tightly throttled route more
 * times than its per-minute budget starts 429ing on assertions that have nothing to do
 * with throttling. Clearing the buckets between tests restores per-test independence; the
 * guard itself stays installed exactly as it is in production, so a test that wants to
 * prove the limit still can within its own bucket.
 */
export async function resetThrottle(app: INestApplication): Promise<void> {
  await app.get(RedisThrottlerStorage).reset()
}
