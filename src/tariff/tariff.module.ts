import { Module } from '@nestjs/common'
import { OperatorScopeService } from '../common/authz/operator-scope.service'
import { TariffController } from './tariff.controller'
import { TariffService } from './tariff.service'

@Module({
  controllers: [TariffController],
  providers: [TariffService, OperatorScopeService],
  exports: [TariffService],
})
export class TariffModule {}
