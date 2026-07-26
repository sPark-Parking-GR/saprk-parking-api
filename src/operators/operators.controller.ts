import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common'
import type { AuthUser } from '@spark/types'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { Roles } from '../auth/decorators/roles.decorator'
import { OperatorsService } from './operators.service'

@Controller('operators')
export class OperatorsController {
  constructor(private readonly operators: OperatorsService) {}

  @Roles('platform_admin')
  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.operators.list(user)
  }

  @Roles('platform_admin')
  @Get(':id')
  getDetail(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.operators.getDetail(user, id)
  }

  @Roles('platform_admin')
  @HttpCode(204)
  @Post(':id/suspend')
  suspend(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.operators.suspend(user, id)
  }

  @Roles('platform_admin')
  @HttpCode(204)
  @Post(':id/reactivate')
  reactivate(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.operators.reactivate(user, id)
  }
}
