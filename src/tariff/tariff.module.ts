import { Module } from '@nestjs/common'
import { OperatorScopeService } from '../common/authz/operator-scope.service'
import { LifecycleModule } from '../lifecycle/lifecycle.module'
import { SubscriptionsModule } from '../subscriptions/subscriptions.module'
import { TariffController } from './tariff.controller'
import { TariffService } from './tariff.service'

// LifecycleModule owns the archive transition a plan delete performs. It imports only
// SubscriptionsModule, so nothing here closes a cycle back onto TariffModule.
@Module({
  imports: [SubscriptionsModule, LifecycleModule],
  controllers: [TariffController],
  providers: [TariffService, OperatorScopeService],
  exports: [TariffService],
})
export class TariffModule {}
