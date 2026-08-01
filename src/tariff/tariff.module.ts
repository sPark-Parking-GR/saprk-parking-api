import { Module } from '@nestjs/common'
import { OperatorScopeService } from '../common/authz/operator-scope.service'
import { SubscriptionsModule } from '../subscriptions/subscriptions.module'
import { TariffController } from './tariff.controller'
import { TariffService } from './tariff.service'

@Module({
  imports: [SubscriptionsModule],
  controllers: [TariffController],
  providers: [TariffService, OperatorScopeService],
  exports: [TariffService],
})
export class TariffModule {}
