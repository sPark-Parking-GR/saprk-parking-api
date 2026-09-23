import { BullModule, InjectQueue } from '@nestjs/bullmq'
import { Module, type OnModuleInit } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Queue } from 'bullmq'
import { InventoryModule } from '../inventory/inventory.module'
import { LifecycleModule } from '../lifecycle/lifecycle.module'
import { DriverSubscriptionsModule } from '../subscriptions/driver-subscriptions.module'
import { DriverSavingsProcessor } from './driver-savings.processor'
import { InventoryCleanupProcessor } from './inventory-cleanup.processor'
import { LifecyclePurgeProcessor } from './lifecycle-purge.processor'
import { parseRedisConnection } from '../config/env.schema'
import {
  CLEANUP_INTERVAL_MS,
  DRIVER_SAVINGS_SUMMARY_JOB,
  ENGAGEMENT_QUEUE,
  INVENTORY_QUEUE,
  LIFECYCLE_QUEUE,
  PURGE_INTERVAL_MS,
  PURGE_TOMBSTONED_JOB,
  RELEASE_EXPIRED_HOLDS_JOB,
  SAVINGS_SUMMARY_INTERVAL_MS,
} from './jobs.constants'

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: parseRedisConnection(config.get<string>('REDIS_URL')),
      }),
    }),
    BullModule.registerQueue({ name: INVENTORY_QUEUE }),
    BullModule.registerQueue({ name: LIFECYCLE_QUEUE }),
    BullModule.registerQueue({ name: ENGAGEMENT_QUEUE }),
    InventoryModule,
    LifecycleModule,
    DriverSubscriptionsModule,
  ],
  providers: [InventoryCleanupProcessor, LifecyclePurgeProcessor, DriverSavingsProcessor],
})
export class JobsModule implements OnModuleInit {
  constructor(
    @InjectQueue(INVENTORY_QUEUE) private readonly inventoryQueue: Queue,
    @InjectQueue(LIFECYCLE_QUEUE) private readonly lifecycleQueue: Queue,
    @InjectQueue(ENGAGEMENT_QUEUE) private readonly engagementQueue: Queue,
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
    await this.engagementQueue.upsertJobScheduler(
      'driver-savings-summary',
      { every: SAVINGS_SUMMARY_INTERVAL_MS },
      { name: DRIVER_SAVINGS_SUMMARY_JOB },
    )
  }
}
