import { Module } from '@nestjs/common'
import { InventoryModule } from '../inventory/inventory.module'
import { TariffModule } from '../tariff/tariff.module'
import { FacilitiesController } from './facilities.controller'
import { FacilitiesService } from './facilities.service'

@Module({
  imports: [InventoryModule, TariffModule],
  controllers: [FacilitiesController],
  providers: [FacilitiesService],
  exports: [FacilitiesService],
})
export class FacilitiesModule {}
