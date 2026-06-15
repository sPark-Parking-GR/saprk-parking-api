import { Processor, WorkerHost } from '@nestjs/bullmq'
import { Logger } from '@nestjs/common'
import { InventoryService } from '../inventory/inventory.service'
import { INVENTORY_QUEUE } from './jobs.constants'

@Processor(INVENTORY_QUEUE)
export class InventoryCleanupProcessor extends WorkerHost {
  private readonly logger = new Logger(InventoryCleanupProcessor.name)

  constructor(private readonly inventory: InventoryService) {
    super()
  }

  async process(): Promise<void> {
    const released = await this.inventory.releaseExpiredHolds()
    if (released > 0) {
      this.logger.log(`Released ${released} expired booking hold(s)`)
    }
  }
}
