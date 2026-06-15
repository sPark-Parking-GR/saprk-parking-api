import { BullModule, InjectQueue } from '@nestjs/bullmq'
import { Module, type OnModuleInit } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Queue } from 'bullmq'
import { InventoryModule } from '../inventory/inventory.module'
import { InventoryCleanupProcessor } from './inventory-cleanup.processor'
import { CLEANUP_INTERVAL_MS, INVENTORY_QUEUE, RELEASE_EXPIRED_HOLDS_JOB } from './jobs.constants'

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
    InventoryModule,
  ],
  providers: [InventoryCleanupProcessor],
})
export class JobsModule implements OnModuleInit {
  constructor(@InjectQueue(INVENTORY_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'expired-hold-cleanup',
      { every: CLEANUP_INTERVAL_MS },
      { name: RELEASE_EXPIRED_HOLDS_JOB },
    )
  }
}
