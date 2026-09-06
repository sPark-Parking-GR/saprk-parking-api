import { ThrottlerStorage, type ThrottlerStorageService } from '@nestjs/throttler'
import type { INestApplication } from '@nestjs/common'

/**
 * Rate limits are keyed by (client IP, handler) and every request in a suite arrives from
 * the same loopback address, so a suite that exercises one tightly throttled route more
 * times than its per-minute budget starts 429ing on assertions that have nothing to do
 * with throttling. Clearing the in-memory buckets between tests restores per-test
 * independence; the guard itself stays installed exactly as it is in production, so a test
 * that wants to prove the limit still can within its own bucket.
 */
export function resetThrottle(app: INestApplication): void {
  const storage = app.get<ThrottlerStorageService>(ThrottlerStorage)
  // Every hit schedules a timer that decrements its bucket when the TTL expires, and that
  // callback dereferences the bucket unguarded. Dropping the buckets without dropping the
  // timers leaves each one to fire against a key that no longer exists and throw from
  // inside a timer, where Jest can only attribute it to whichever test happens to be
  // running. onApplicationShutdown is the only public surface that clears them, and it
  // leaves the storage map alone, so the two compose.
  storage.onApplicationShutdown()
  storage.storage.clear()
}
