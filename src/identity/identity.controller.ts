import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common'
import type { AuthUser } from '@spark/types'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { RequirePermission } from '../auth/decorators/require-permission.decorator'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe'
import {
  assignRoleSchema,
  listUsersSchema,
  reasonRequiredSchema,
  type AssignRoleDto,
  type ListUsersDto,
  type ReasonRequiredDto,
} from './dto/identity.dto'
import { IdentityApprovalService } from './identity-approval.service'
import { IdentityService } from './identity.service'

/**
 * The account-management surface, gated on the identity:* family in full. Platform admins
 * hold every platform:* capability and none of these, so this controller is one of the two
 * places the two administrative tiers actually differ — the other being the `user` resource
 * type on the lifecycle surface, which these routes exist to give a way to reach.
 *
 * The static `approvals` routes are declared before the `:id` ones so the file reads in the
 * order the router resolves them.
 */
@Controller('admin/users')
export class IdentityController {
  constructor(
    private readonly identity: IdentityService,
    private readonly approvals: IdentityApprovalService,
  ) {}

  @RequirePermission('identity:user.read')
  @Get()
  list(
    @Query(new ZodValidationPipe(listUsersSchema)) query: ListUsersDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.identity.list(user, query)
  }

  @RequirePermission('identity:role.assign')
  @Get('approvals')
  listApprovals(@CurrentUser() user: AuthUser) {
    return this.approvals.list(user)
  }

  // 200, not 204: the caller gets the approval a second super admin has 24 hours to redeem,
  // and nothing has changed yet.
  @RequirePermission('identity:role.assign')
  @HttpCode(200)
  @Post('approvals/:id/approve')
  approve(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.approvals.approve(user, id)
  }

  @RequirePermission('identity:role.assign')
  @HttpCode(200)
  @Post('approvals/:id/reject')
  reject(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(reasonRequiredSchema)) body: ReasonRequiredDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.approvals.reject(user, id, body.reason)
  }

  @RequirePermission('identity:user.read')
  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.identity.get(user, id)
  }

  @RequirePermission('identity:role.assign')
  @HttpCode(204)
  @Patch(':id/role')
  assignRole(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(assignRoleSchema)) body: AssignRoleDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.identity.assignRole(user, id, body)
  }

  // 202: nothing has been demoted. The response is the approval a DIFFERENT super admin has
  // 24 hours to redeem — the only action permitted against a super administrator.
  @RequirePermission('identity:role.assign')
  @HttpCode(202)
  @Post(':id/demote')
  requestDemotion(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(reasonRequiredSchema)) body: ReasonRequiredDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.approvals.requestDemotion(user, id, body.reason)
  }
}
