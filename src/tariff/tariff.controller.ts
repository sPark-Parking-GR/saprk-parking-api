import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
} from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import type { AuthUser } from '@spark/types'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { Roles } from '../auth/decorators/roles.decorator'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe'
import { TariffService } from './tariff.service'
import {
  simulateSchema,
  tariffDraftSchema,
  type SimulateDto,
  type TariffDraftDto,
} from './dto/tariff.dto'

@Roles('operator_admin', 'platform_admin')
@Controller('facilities/:facilityId/tariff-plans')
export class TariffController {
  constructor(private readonly tariff: TariffService) {}

  @Get()
  list(@Param('facilityId') facilityId: string, @CurrentUser() user: AuthUser) {
    return this.tariff.listPlans(user, facilityId)
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('simulate')
  simulate(
    @Param('facilityId') facilityId: string,
    @Body(new ZodValidationPipe(simulateSchema)) body: SimulateDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.tariff.simulate(user, facilityId, body)
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post()
  @HttpCode(201)
  create(
    @Param('facilityId') facilityId: string,
    @Body(new ZodValidationPipe(tariffDraftSchema)) body: TariffDraftDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.tariff.createPlan(user, facilityId, body)
  }

  @Get(':planId')
  detail(
    @Param('facilityId') facilityId: string,
    @Param('planId') planId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.tariff.getPlanDetail(user, facilityId, planId)
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Patch(':planId')
  update(
    @Param('facilityId') facilityId: string,
    @Param('planId') planId: string,
    @Body(new ZodValidationPipe(tariffDraftSchema)) body: TariffDraftDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.tariff.updatePlan(user, facilityId, planId, body)
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Delete(':planId')
  @HttpCode(204)
  remove(
    @Param('facilityId') facilityId: string,
    @Param('planId') planId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.tariff.softDeletePlan(user, facilityId, planId)
  }
}
