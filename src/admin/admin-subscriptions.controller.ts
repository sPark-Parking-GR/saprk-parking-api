import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common'
import type { AuthUser } from '@spark/types'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { RequirePermission } from '../auth/decorators/require-permission.decorator'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe'
import {
  archivePlanSchema,
  assignSubscriptionSchema,
  createPlanSchema,
  listPlansSchema,
  setOverrideSchema,
  updatePlanSchema,
  type ArchivePlanDto,
  type AssignSubscriptionDto,
  type CreatePlanDto,
  type ListPlansDto,
  type SetOverrideDto,
  type UpdatePlanDto,
} from '../subscriptions/dto/subscriptions.dto'
import { SubscriptionAdminService } from '../subscriptions/subscription-admin.service'

/**
 * One permission for the whole surface: `platform:billing.manage`. Reading a tenant's
 * entitlements is not separated out under tenant.read because the effective limits are
 * commercial terms — what was negotiated and at what price — and the plan catalog they are
 * read against is the same object the write routes edit.
 *
 * The static `plans` routes are declared before the `operators` ones so the file reads in
 * the order the router resolves them. Every handler's service method re-checks the same
 * permission, per the both-layers rule.
 */
@Controller('admin/subscriptions')
export class AdminSubscriptionsController {
  constructor(private readonly admin: SubscriptionAdminService) {}

  @RequirePermission('platform:billing.manage')
  @Get('plans')
  listPlans(
    @Query(new ZodValidationPipe(listPlansSchema)) query: ListPlansDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.admin.listPlans(user, query)
  }

  @RequirePermission('platform:billing.manage')
  @Post('plans')
  createPlan(
    @Body(new ZodValidationPipe(createPlanSchema)) body: CreatePlanDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.admin.createPlan(user, body)
  }

  @RequirePermission('platform:billing.manage')
  @Patch('plans/:id')
  updatePlan(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updatePlanSchema)) body: UpdatePlanDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.admin.updatePlan(user, id, body)
  }

  @RequirePermission('platform:billing.manage')
  @HttpCode(200)
  @Post('plans/:id/archive')
  archivePlan(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(archivePlanSchema)) body: ArchivePlanDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.admin.archivePlan(user, id, body)
  }

  @RequirePermission('platform:billing.manage')
  @Get('operators/:operatorId')
  getOperator(@Param('operatorId') operatorId: string, @CurrentUser() user: AuthUser) {
    return this.admin.getOperatorSubscription(user, operatorId)
  }

  @RequirePermission('platform:billing.manage')
  @Put('operators/:operatorId')
  assign(
    @Param('operatorId') operatorId: string,
    @Body(new ZodValidationPipe(assignSubscriptionSchema)) body: AssignSubscriptionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.admin.assignSubscription(user, operatorId, body)
  }

  @RequirePermission('platform:billing.manage')
  @Put('operators/:operatorId/override')
  setOverride(
    @Param('operatorId') operatorId: string,
    @Body(new ZodValidationPipe(setOverrideSchema)) body: SetOverrideDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.admin.setOverride(user, operatorId, body)
  }
}
