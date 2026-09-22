import { Module } from '@nestjs/common'
import { OperatorScopeService } from '../common/authz/operator-scope.service'
import { OperatorsModule } from '../operators/operators.module'
import { FacilityManagersController } from './facility-managers.controller'
import { ResourceManagersService } from './resource-managers.service'
import { TariffPlanManagersController } from './tariff-plan-managers.controller'

// OperatorsModule is imported for OperatorAccessService, which already answers "may this
// caller administer that operator?" for member role changes and invites — the same
// question a manager assignment asks. It depends on nothing here, so there is no cycle.
@Module({
  imports: [OperatorsModule],
  controllers: [FacilityManagersController, TariffPlanManagersController],
  providers: [ResourceManagersService, OperatorScopeService],
})
export class ManagersModule {}
