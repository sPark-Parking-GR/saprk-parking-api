import { Processor, WorkerHost } from '@nestjs/bullmq'
import { Logger } from '@nestjs/common'
import {
  DriverSavingsService,
  type SavingsSummaryRun,
} from '../subscriptions/driver-savings.service'
import { ENGAGEMENT_QUEUE } from './jobs.constants'

@Processor(ENGAGEMENT_QUEUE)
export class DriverSavingsProcessor extends WorkerHost {
  private readonly logger = new Logger(DriverSavingsProcessor.name)

  constructor(private readonly savings: DriverSavingsService) {
    super()
  }

  async process(): Promise<void> {
    const run = await this.savings.sendSavingsSummaries()
    // Quiet when it did nothing, like the other two processors — but a sweep that found
    // candidates and mailed none of them is not nothing, so the guard is on candidates
    // rather than on sends.
    if (run.candidates > 0) {
      this.logger.log(format(run))
    }
  }
}

function format(run: SavingsSummaryRun): string {
  return (
    `Driver savings summaries: ${run.sent} sent of ${run.candidates} candidate(s) ` +
    `(${run.alreadySummarised} already summarised, ${run.unreachable} unreachable, ` +
    `${run.mixedCurrency} mixed-currency, ${run.failed} failed)`
  )
}
