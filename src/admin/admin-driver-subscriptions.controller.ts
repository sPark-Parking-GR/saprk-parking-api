import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common'
import type { AuthUser } from '@spark/types'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { RequirePermission } from '../auth/decorators/require-permission.decorator'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe'
import {
  archiveDriverPlanSchema,
  assignDriverSubscriptionSchema,
  createDriverPlanSchema,
  listDriverPlansSchema,
  setDriverOverrideSchema,
  updateDriverPlanSchema,
  type ArchiveDriverPlanDto,
  type AssignDriverSubscriptionDto,
  type CreateDriverPlanDto,
  type ListDriverPlansDto,
  type SetDriverOverrideDto,
  type UpdateDriverPlanDto,
} from '../subscriptions/dto/driver-subscriptions.dto'
import { DriverSubscriptionAdminService } from '../subscriptions/driver-subscription-admin.service'

/**
 * The rider half of the billing surface, on its own prefix so the two catalogs are never
 * one route apart from each other. Same single permission as the operator controller —
 * `platform:billing.manage` — because it is the same commercial authority over a different
 * audience, and the administrative-tiers table already gives it to both admin tiers.
 *
 * The static `plans` routes are declared before the `users` ones so the file reads in the
 * order the router resolves them. Every handler's service method re-checks the same
 * permission, per the both-layers rule.
 */
@Controller('admin/driver-subscriptions')
export class AdminDriverSubscriptionsController {
  constructor(private readonly admin: DriverSubscriptionAdminService) {}

  @RequirePermission('platform:billing.manage')
  @Get('plans')
  listPlans(
    @Query(new ZodValidationPipe(listDriverPlansSchema)) query: ListDriverPlansDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.admin.listPlans(user, query)
  }

  @RequirePermission('platform:billing.manage')
  @Post('plans')
  createPlan(
    @Body(new ZodValidationPipe(createDriverPlanSchema)) body: CreateDriverPlanDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.admin.createPlan(user, body)
  }

  @RequirePermission('platform:billing.manage')
  @Patch('plans/:id')
  updatePlan(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateDriverPlanSchema)) body: UpdateDriverPlanDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.admin.updatePlan(user, id, body)
  }

  @RequirePermission('platform:billing.manage')
  @HttpCode(200)
  @Post('plans/:id/archive')
  archivePlan(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(archiveDriverPlanSchema)) body: ArchiveDriverPlanDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.admin.archivePlan(user, id, body)
  }

  @RequirePermission('platform:billing.manage')
  @Get('users/:userId')
  getDriver(@Param('userId') userId: string, @CurrentUser() user: AuthUser) {
    return this.admin.getDriverSubscription(user, userId)
  }

  @RequirePermission('platform:billing.manage')
  @Put('users/:userId')
  assign(
    @Param('userId') userId: string,
    @Body(new ZodValidationPipe(assignDriverSubscriptionSchema)) body: AssignDriverSubscriptionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.admin.assignSubscription(user, userId, body)
  }

  @RequirePermission('platform:billing.manage')
  @Put('users/:userId/override')
  setOverride(
    @Param('userId') userId: string,
    @Body(new ZodValidationPipe(setDriverOverrideSchema)) body: SetDriverOverrideDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.admin.setOverride(user, userId, body)
  }
}
