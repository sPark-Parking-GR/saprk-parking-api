import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common'
import type { AuthUser } from '@spark/types'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { RequirePermission } from '../auth/decorators/require-permission.decorator'
import { OperatorsService } from './operators.service'

@Controller('admin/operators')
export class OperatorsController {
  constructor(private readonly operators: OperatorsService) {}

  @RequirePermission('platform:tenant.read')
  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.operators.list(user)
  }

  @RequirePermission('platform:tenant.read')
  @Get(':id')
  getDetail(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.operators.getDetail(user, id)
  }

  @RequirePermission('platform:tenant.write')
  @HttpCode(204)
  @Post(':id/suspend')
  suspend(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.operators.suspend(user, id)
  }

  @RequirePermission('platform:tenant.write')
  @HttpCode(204)
  @Post(':id/reactivate')
  reactivate(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.operators.reactivate(user, id)
  }
}
