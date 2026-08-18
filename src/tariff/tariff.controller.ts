import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import type { AuthUser } from '@spark/types'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { RequireOrgPermission } from '../auth/decorators/require-org-permission.decorator'
import { Roles } from '../auth/decorators/roles.decorator'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe'
import { TariffService } from './tariff.service'
import {
  listTariffPlansSchema,
  simulateSchema,
  tariffDraftSchema,
  type ListTariffPlansDto,
  type SimulateDto,
  type TariffDraftDto,
} from './dto/tariff.dto'

@Roles('operator_admin', 'platform_admin', 'super_admin')
@RequireOrgPermission('org:tariff.write')
@Controller('tariff-plans')
export class TariffController {
  constructor(private readonly tariff: TariffService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(listTariffPlansSchema)) query: ListTariffPlansDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.tariff.listPlans(user, query)
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('simulate')
  simulate(
    @Body(new ZodValidationPipe(simulateSchema)) body: SimulateDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.tariff.simulate(user, body)
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post()
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(tariffDraftSchema)) body: TariffDraftDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.tariff.createPlan(user, body)
  }

  @Get(':id')
  detail(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.tariff.getPlanDetail(user, id)
  }

  @Get(':id/assignments')
  assignments(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.tariff.getAssignments(user, id)
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(tariffDraftSchema)) body: TariffDraftDto,
    @CurrentUser() user: AuthUser,
    @Query('newDefaultPlanId') newDefaultPlanId?: string,
  ) {
    return this.tariff.updatePlan(user, id, body, newDefaultPlanId || undefined)
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Delete(':id')
  @HttpCode(204)
  remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Query('newDefaultPlanId') newDefaultPlanId?: string,
  ) {
    return this.tariff.deletePlan(user, id, newDefaultPlanId || undefined)
  }
}
