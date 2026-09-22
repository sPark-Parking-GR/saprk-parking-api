import { Module } from '@nestjs/common'
import { OperatorScopeService } from '../common/authz/operator-scope.service'
import { OperatorAccessService } from '../operators/operator-access.service'
import { LifecycleModule } from '../lifecycle/lifecycle.module'
import { DriverSubscriptionsModule } from '../subscriptions/driver-subscriptions.module'
import { SubscriptionsModule } from '../subscriptions/subscriptions.module'
import { TariffController } from './tariff.controller'
import { TariffService } from './tariff.service'

// LifecycleModule owns the archive transition a plan delete performs. It imports only
// SubscriptionsModule, so nothing here closes a cycle back onto TariffModule.
// DriverSubscriptionsModule is imported for DriverEntitlementService: the rider's booking
// discount is resolved at the same price-capture point as the operator's commission.
@Module({
  imports: [SubscriptionsModule, DriverSubscriptionsModule, LifecycleModule],
  controllers: [TariffController],
  providers: [TariffService, OperatorScopeService, OperatorAccessService],
  exports: [TariffService],
})
export class TariffModule {}
