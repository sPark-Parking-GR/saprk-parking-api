import { Module } from '@nestjs/common'
import { BookingModule } from '../booking/booking.module'
import { OperatorScopeService } from '../common/authz/operator-scope.service'
import { InventoryModule } from '../inventory/inventory.module'
import { SubscriptionsModule } from '../subscriptions/subscriptions.module'
import { TariffModule } from '../tariff/tariff.module'
import { FacilitiesController } from './facilities.controller'
import { FacilitiesService } from './facilities.service'
import { SavedFacilitiesController } from './saved-facilities.controller'
import { SavedFacilitiesService } from './saved-facilities.service'

// BookingModule is imported for its cancel/refund path: force-deactivating a facility
// must reuse BookingService.cancelBooking rather than grow a second refund
// implementation. BookingModule does not depend on this one, so there is no cycle.
@Module({
  imports: [InventoryModule, TariffModule, BookingModule, SubscriptionsModule],
  controllers: [FacilitiesController, SavedFacilitiesController],
  providers: [FacilitiesService, SavedFacilitiesService, OperatorScopeService],
  exports: [FacilitiesService, OperatorScopeService],
})
export class FacilitiesModule {}
