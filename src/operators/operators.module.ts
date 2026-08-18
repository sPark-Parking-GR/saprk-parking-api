import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { OperatorScopeService } from '../common/authz/operator-scope.service'
import { OperatorAccessService } from './operator-access.service'
import { OperatorRegistrationController } from './operator-registration.controller'
import { OperatorRegistrationService } from './operator-registration.service'
import { OperatorMembersController } from './operator-members.controller'
import { OperatorMembersService } from './operator-members.service'
import { OperatorsController } from './operators.controller'
import { OperatorsService } from './operators.service'

@Module({
  imports: [AuthModule],
  controllers: [OperatorsController, OperatorMembersController, OperatorRegistrationController],
  providers: [
    OperatorsService,
    OperatorMembersService,
    OperatorAccessService,
    OperatorRegistrationService,
    OperatorScopeService,
  ],
  exports: [OperatorAccessService],
})
export class OperatorsModule {}
