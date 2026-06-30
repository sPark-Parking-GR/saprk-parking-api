import { BullModule, InjectQueue } from '@nestjs/bullmq'
import { Module, type OnModuleInit } from '@nestjs/common'
import { Queue } from 'bullmq'
import { MapsModule } from '../maps/maps.module'
import {
  GOOGLE_REFRESH_JOB,
  INGESTION_GOOGLE_QUEUE,
  INGESTION_PROMOTE_QUEUE,
  INGESTION_QUEUE,
  INGESTION_REFRESH_QUEUE,
  REFRESH_INTERVAL_MS,
} from './ingestion.constants'
import { GoogleFetchProcessor } from './google.processor'
import { IngestionController } from './ingestion.controller'
import { IngestionService } from './ingestion.service'
import { OverpassClient } from './overpass.client'
import { OverpassProcessor } from './overpass.processor'
import { PromotionProcessor } from './promotion.processor'
import { PromotionService } from './promotion.service'
import { RefreshProcessor } from './refresh.processor'
import { RefreshService } from './refresh.service'

@Module({
  imports: [
    MapsModule,
    BullModule.registerQueue({ name: INGESTION_QUEUE }),
    BullModule.registerQueue({ name: INGESTION_GOOGLE_QUEUE }),
    BullModule.registerQueue({ name: INGESTION_PROMOTE_QUEUE }),
    BullModule.registerQueue({ name: INGESTION_REFRESH_QUEUE }),
  ],
  controllers: [IngestionController],
  providers: [
    IngestionService,
    OverpassClient,
    OverpassProcessor,
    GoogleFetchProcessor,
    PromotionService,
    PromotionProcessor,
    RefreshService,
    RefreshProcessor,
  ],
})
export class IngestionModule implements OnModuleInit {
  constructor(@InjectQueue(INGESTION_REFRESH_QUEUE) private readonly refreshQueue: Queue) {}

  async onModuleInit(): Promise<void> {
    await this.refreshQueue.upsertJobScheduler(
      'google-refresh-daily',
      { every: REFRESH_INTERVAL_MS },
      { name: GOOGLE_REFRESH_JOB },
    )
  }
}
