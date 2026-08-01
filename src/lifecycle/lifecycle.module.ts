import { Module } from '@nestjs/common'
import { LifecyclePurgeService } from './lifecycle-purge.service'
import { LifecycleService } from './lifecycle.service'

@Module({
  providers: [LifecycleService, LifecyclePurgeService],
  exports: [LifecycleService, LifecyclePurgeService],
})
export class LifecycleModule {}
