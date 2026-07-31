import { Module } from '@nestjs/common'
import { OperatorScopeService } from '../common/authz/operator-scope.service'
import { OperatorAccessService } from './operator-access.service'
import { OperatorMembersController } from './operator-members.controller'
import { OperatorMembersService } from './operator-members.service'
import { OperatorsController } from './operators.controller'
import { OperatorsService } from './operators.service'

@Module({
  controllers: [OperatorsController, OperatorMembersController],
  providers: [
    OperatorsService,
    OperatorMembersService,
    OperatorAccessService,
    OperatorScopeService,
  ],
  exports: [OperatorAccessService],
})
export class OperatorsModule {}
