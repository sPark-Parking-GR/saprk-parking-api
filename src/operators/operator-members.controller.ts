import { Body, Controller, Delete, Get, HttpCode, Param, Patch } from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import type { AuthUser } from '@spark/types'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { Roles } from '../auth/decorators/roles.decorator'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe'
import { changeMemberRoleSchema, type ChangeMemberRoleDto } from './dto/operator-members.dto'
import { OperatorMembersService } from './operator-members.service'

@Roles('operator_admin', 'platform_admin', 'super_admin')
@Controller('operators/:operatorId/members')
export class OperatorMembersController {
  constructor(private readonly members: OperatorMembersService) {}

  @Get()
  list(@Param('operatorId') operatorId: string, @CurrentUser() user: AuthUser) {
    return this.members.list(user, operatorId)
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Patch(':userId')
  changeRole(
    @Param('operatorId') operatorId: string,
    @Param('userId') userId: string,
    @Body(new ZodValidationPipe(changeMemberRoleSchema)) body: ChangeMemberRoleDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.members.changeRole(user, operatorId, userId, body.role)
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(204)
  @Delete(':userId')
  remove(
    @Param('operatorId') operatorId: string,
    @Param('userId') userId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.members.remove(user, operatorId, userId)
  }
}
