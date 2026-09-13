import { Module } from '@nestjs/common'
import { RedisThrottlerStorage } from './redis-throttler-storage'

// A dedicated module so ThrottlerModule.forRootAsync can pull RedisThrottlerStorage in via
// `imports` + `inject` — it is not @Global like ConfigModule, so without this it would be
// invisible to the dynamic module's own injector.
@Module({
  providers: [RedisThrottlerStorage],
  exports: [RedisThrottlerStorage],
})
export class RedisThrottlerStorageModule {}
