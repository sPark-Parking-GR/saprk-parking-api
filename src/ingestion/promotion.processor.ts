import { Processor, WorkerHost } from '@nestjs/bullmq'
import type { Job } from 'bullmq'
import { INGESTION_PROMOTE_QUEUE } from './ingestion.constants'
import { PromotionService } from './promotion.service'

@Processor(INGESTION_PROMOTE_QUEUE, { concurrency: 1 })
export class PromotionProcessor extends WorkerHost {
  constructor(private readonly promotion: PromotionService) {
    super()
  }

  async process(_job: Job): Promise<void> {
    await this.promotion.drainPending()
  }
}
