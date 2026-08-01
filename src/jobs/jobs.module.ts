import { BullModule, InjectQueue } from '@nestjs/bullmq'
import { Module, type OnModuleInit } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Queue } from 'bullmq'
import { InventoryModule } from '../inventory/inventory.module'
import { LifecycleModule } from '../lifecycle/lifecycle.module'
import { InventoryCleanupProcessor } from './inventory-cleanup.processor'
import { LifecyclePurgeProcessor } from './lifecycle-purge.processor'
import {
  CLEANUP_INTERVAL_MS,
  INVENTORY_QUEUE,
  LIFECYCLE_QUEUE,
  PURGE_INTERVAL_MS,
  PURGE_TOMBSTONED_JOB,
  RELEASE_EXPIRED_HOLDS_JOB,
} from './jobs.constants'

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = new URL(config.get<string>('REDIS_URL') ?? 'redis://localhost:6379')
        return {
          connection: {
            host: url.hostname,
            port: Number(url.port || 6379),
            username: url.username || undefined,
            password: url.password || undefined,
          },
        }
      },
    }),
    BullModule.registerQueue({ name: INVENTORY_QUEUE }),
    BullModule.registerQueue({ name: LIFECYCLE_QUEUE }),
    InventoryModule,
    LifecycleModule,
  ],
  providers: [InventoryCleanupProcessor, LifecyclePurgeProcessor],
})
export class JobsModule implements OnModuleInit {
  constructor(
    @InjectQueue(INVENTORY_QUEUE) private readonly inventoryQueue: Queue,
    @InjectQueue(LIFECYCLE_QUEUE) private readonly lifecycleQueue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.inventoryQueue.upsertJobScheduler(
      'expired-hold-cleanup',
      { every: CLEANUP_INTERVAL_MS },
      { name: RELEASE_EXPIRED_HOLDS_JOB },
    )
    await this.lifecycleQueue.upsertJobScheduler(
      'lifecycle-purge',
      { every: PURGE_INTERVAL_MS },
      { name: PURGE_TOMBSTONED_JOB },
    )
  }
}
