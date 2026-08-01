import { Module } from '@nestjs/common'
import { BookingModule } from '../booking/booking.module'
import { OperatorScopeService } from '../common/authz/operator-scope.service'
import { InventoryModule } from '../inventory/inventory.module'
import { LifecycleModule } from '../lifecycle/lifecycle.module'
import { SubscriptionsModule } from '../subscriptions/subscriptions.module'
import { TariffModule } from '../tariff/tariff.module'
import { FacilitiesController } from './facilities.controller'
import { FacilitiesService } from './facilities.service'
import { SavedFacilitiesController } from './saved-facilities.controller'
import { SavedFacilitiesService } from './saved-facilities.service'

// BookingModule is imported for its cancel/refund path: force-deactivating a facility
// must reuse BookingService.cancelBooking rather than grow a second refund
// implementation. BookingModule does not depend on this one, so there is no cycle.
//
// LifecycleModule owns the archive transition a facility delete now performs. It depends
// only on SubscriptionsModule, so it introduces no cycle either — and the predicate the
// two used to share lives in booking/booking.predicates.ts precisely to keep the FILE
// graph acyclic now that facilities.service imports lifecycle.service.
@Module({
  imports: [InventoryModule, TariffModule, BookingModule, SubscriptionsModule, LifecycleModule],
  controllers: [FacilitiesController, SavedFacilitiesController],
  providers: [FacilitiesService, SavedFacilitiesService, OperatorScopeService],
  exports: [FacilitiesService, OperatorScopeService],
})
export class FacilitiesModule {}
