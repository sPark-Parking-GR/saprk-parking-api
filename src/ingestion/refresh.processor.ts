import { Processor, WorkerHost } from '@nestjs/bullmq'
import type { Job } from 'bullmq'
import { INGESTION_REFRESH_QUEUE } from './ingestion.constants'
import { RefreshService } from './refresh.service'

@Processor(INGESTION_REFRESH_QUEUE, { concurrency: 1, limiter: { max: 5, duration: 1_000 } })
export class RefreshProcessor extends WorkerHost {
  constructor(private readonly refresh: RefreshService) {
    super()
  }

  async process(_job: Job): Promise<void> {
    await this.refresh.refreshStale()
  }
}
