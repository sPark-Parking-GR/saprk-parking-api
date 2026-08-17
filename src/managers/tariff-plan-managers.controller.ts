import { Body, Controller, Get, Param, Put } from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import type { AuthUser } from '@spark/types'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { Roles } from '../auth/decorators/roles.decorator'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe'
import { replaceManagersSchema, type ReplaceManagersDto } from './dto/managers.dto'
import { ResourceManagersService } from './resource-managers.service'

// See FacilityManagersController for why these live on the resource and not under /admin.
@Roles('operator_admin', 'platform_admin', 'super_admin')
@Controller('tariff-plans')
export class TariffPlanManagersController {
  constructor(private readonly managers: ResourceManagersService) {}

  @Get(':id/managers')
  list(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.managers.listTariffPlanManagers(user, id)
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Put(':id/managers')
  replace(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(replaceManagersSchema)) body: ReplaceManagersDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.managers.replaceTariffPlanManagers(user, id, body.userIds)
  }
}
