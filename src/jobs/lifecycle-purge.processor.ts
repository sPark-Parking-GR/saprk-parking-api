import { Processor, WorkerHost } from '@nestjs/bullmq'
import { Logger } from '@nestjs/common'
import { LifecyclePurgeService, type PurgeSummary } from '../lifecycle/lifecycle-purge.service'
import { LIFECYCLE_QUEUE } from './jobs.constants'

@Processor(LIFECYCLE_QUEUE)
export class LifecyclePurgeProcessor extends WorkerHost {
  private readonly logger = new Logger(LifecyclePurgeProcessor.name)

  constructor(private readonly purge: LifecyclePurgeService) {
    super()
  }

  async process(): Promise<void> {
    const summary = await this.purge.purgeDue()
    if (hasActivity(summary)) {
      this.logger.log(
        `Lifecycle purge: facilities ${format(summary.facilities)}, ` +
          `tariff plans ${format(summary.tariffPlans)}, operators ${format(summary.operators)}, ` +
          `users ${format(summary.users)}`,
      )
    }
  }
}

function hasActivity(summary: PurgeSummary): boolean {
  return Object.values(summary).some((counts) => counts.purged > 0 || counts.blocked > 0)
}

function format(counts: { purged: number; blocked: number }): string {
  return `${counts.purged} purged / ${counts.blocked} blocked`
}
