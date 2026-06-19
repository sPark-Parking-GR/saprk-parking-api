import { Module } from '@nestjs/common'
import { OperatorScopeService } from '../common/authz/operator-scope.service'
import { InventoryModule } from '../inventory/inventory.module'
import { TariffModule } from '../tariff/tariff.module'
import { FacilitiesController } from './facilities.controller'
import { FacilitiesService } from './facilities.service'

@Module({
  imports: [InventoryModule, TariffModule],
  controllers: [FacilitiesController],
  providers: [FacilitiesService, OperatorScopeService],
  exports: [FacilitiesService, OperatorScopeService],
})
export class FacilitiesModule {}
