import { Processor, WorkerHost } from '@nestjs/bullmq'
import type { Job } from 'bullmq'
import { INGESTION_PROMOTE_QUEUE, RECLASSIFY_JOB } from './ingestion.constants'
import { PromotionService } from './promotion.service'

@Processor(INGESTION_PROMOTE_QUEUE, { concurrency: 1 })
export class PromotionProcessor extends WorkerHost {
  constructor(private readonly promotion: PromotionService) {
    super()
  }

  async process(job: Job): Promise<void> {
    if (job.name === RECLASSIFY_JOB) {
      await this.promotion.reclassifyUnknown()
      return
    }
    await this.promotion.drainPending()
  }
}
