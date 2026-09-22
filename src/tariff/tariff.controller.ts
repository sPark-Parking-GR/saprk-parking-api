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

/**
 * The class-level scope was `org:tariff.write` for every route, which made the read scope
 * meaningless — nothing in the codebase ever asked for `org:tariff.read`, so a member who
 * held only it could not read. Each handler now names the scope it actually needs.
 *
 * `@Roles` stays at admin-and-above for the whole controller: no tariff route admits
 * OPERATOR_STAFF today, so the read scope is still unreachable by an attendant and is
 * listed in STAFF_FORBIDDEN_SCOPES for that reason. Splitting it here is what makes
 * admitting them later a one-line decision rather than a re-audit.
 */
@Roles('operator_admin', 'platform_admin', 'super_admin')
@Controller('tariff-plans')
export class TariffController {
  constructor(private readonly tariff: TariffService) {}

  @RequireOrgPermission('org:tariff.read')
  @Get()
  list(
    @Query(new ZodValidationPipe(listTariffPlansSchema)) query: ListTariffPlansDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.tariff.listPlans(user, query)
  }

  // Prices a draft and writes nothing, so it reads rather than writes.
  @RequireOrgPermission('org:tariff.read')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('simulate')
  simulate(
    @Body(new ZodValidationPipe(simulateSchema)) body: SimulateDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.tariff.simulate(user, body)
  }

  @RequireOrgPermission('org:tariff.write')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post()
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(tariffDraftSchema)) body: TariffDraftDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.tariff.createPlan(user, body)
  }

  @RequireOrgPermission('org:tariff.read')
  @Get(':id')
  detail(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.tariff.getPlanDetail(user, id)
  }

  @RequireOrgPermission('org:tariff.read')
  @Get(':id/assignments')
  assignments(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.tariff.getAssignments(user, id)
  }

  @RequireOrgPermission('org:tariff.write')
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

  @RequireOrgPermission('org:tariff.write')
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
