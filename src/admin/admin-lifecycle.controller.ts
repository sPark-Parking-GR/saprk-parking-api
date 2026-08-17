import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common'
import { hasPlatformPermission, type AuthUser, type PlatformPermission } from '@spark/types'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { RequirePermission } from '../auth/decorators/require-permission.decorator'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe'
import {
  impactQuerySchema,
  listTrashSchema,
  reasonOptionalSchema,
  reasonRequiredSchema,
  resourceTypeSchema,
  type ImpactQueryDto,
  type ListTrashDto,
  type ReasonOptionalDto,
  type ReasonRequiredDto,
} from '../lifecycle/dto/lifecycle-admin.dto'
import { LifecycleAdminService } from '../lifecycle/lifecycle-admin.service'
import type { LifecycleResourceType } from '../lifecycle/lifecycle.types'

const resourceTypeParam = new ZodValidationPipe(resourceTypeSchema)

/**
 * The controller half of the platform_admin / super_admin boundary, mirroring
 * LifecycleAdminService.assertMayTouchUsers per the both-layers authorization rule.
 *
 * @RequirePermission cannot express this: which permission a call needs depends on a PATH
 * PARAMETER, not on the route. `user` is one of the four resource types this surface is
 * generic over, so without this check the tenant permissions every platform admin holds
 * would reach every account on the platform.
 *
 * The two approval routes are gated in the service only — an approval names its resource in
 * the row rather than the URL, so there is nothing here to read.
 */
function assertMayTouchUsers(
  user: AuthUser,
  resourceType: LifecycleResourceType,
  permission: PlatformPermission,
): void {
  if (resourceType !== 'user') return
  if (!hasPlatformPermission(user.role, permission)) {
    throw new ForbiddenException('Only super admins may act on user accounts')
  }
}

/**
 * Three permission tiers on one resource, and the split is the point: reading the trash is
 * platform:tenant.read, reversible moves are platform:tenant.write, and anything that
 * starts a countdown to real destruction — tombstone, purge, and deciding a purge — is
 * platform:tenant.purge, which write never implies.
 *
 * The static `trash` and `approvals` routes are declared before the :resourceType ones so
 * the file reads in the order the router resolves them.
 */
@Controller('admin/lifecycle')
export class AdminLifecycleController {
  constructor(private readonly admin: LifecycleAdminService) {}

  @RequirePermission('platform:tenant.read')
  @Get('trash')
  trash(
    @Query(new ZodValidationPipe(listTrashSchema)) query: ListTrashDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.admin.listTrash(user, query)
  }

  @RequirePermission('platform:tenant.purge')
  @Get('approvals')
  approvals(@CurrentUser() user: AuthUser) {
    return this.admin.listApprovals(user)
  }

  @RequirePermission('platform:tenant.purge')
  @HttpCode(200)
  @Post('approvals/:id/approve')
  approve(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.admin.approve(user, id)
  }

  @RequirePermission('platform:tenant.purge')
  @HttpCode(200)
  @Post('approvals/:id/reject')
  reject(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(reasonRequiredSchema)) body: ReasonRequiredDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.admin.reject(user, id, body.reason)
  }

  @RequirePermission('platform:tenant.read')
  @Get(':resourceType/:id/impact')
  impact(
    @Param('resourceType', resourceTypeParam) resourceType: LifecycleResourceType,
    @Param('id') id: string,
    @Query(new ZodValidationPipe(impactQuerySchema)) query: ImpactQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    assertMayTouchUsers(user, resourceType, 'identity:user.read')
    return this.admin.previewImpact(user, resourceType, id, query.action)
  }

  @RequirePermission('platform:tenant.write')
  @HttpCode(204)
  @Post(':resourceType/:id/archive')
  archive(
    @Param('resourceType', resourceTypeParam) resourceType: LifecycleResourceType,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(reasonRequiredSchema)) body: ReasonRequiredDto,
    @CurrentUser() user: AuthUser,
  ) {
    assertMayTouchUsers(user, resourceType, 'identity:user.lifecycle')
    return this.admin.archive(user, resourceType, id, body.reason)
  }

  @RequirePermission('platform:tenant.write')
  @HttpCode(204)
  @Post(':resourceType/:id/restore')
  restore(
    @Param('resourceType', resourceTypeParam) resourceType: LifecycleResourceType,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(reasonOptionalSchema)) body: ReasonOptionalDto,
    @CurrentUser() user: AuthUser,
  ) {
    assertMayTouchUsers(user, resourceType, 'identity:user.lifecycle')
    return this.admin.restore(user, resourceType, id, body.reason)
  }

  @RequirePermission('platform:tenant.purge')
  @HttpCode(204)
  @Post(':resourceType/:id/tombstone')
  tombstone(
    @Param('resourceType', resourceTypeParam) resourceType: LifecycleResourceType,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(reasonRequiredSchema)) body: ReasonRequiredDto,
    @CurrentUser() user: AuthUser,
  ) {
    assertMayTouchUsers(user, resourceType, 'identity:user.lifecycle')
    return this.admin.tombstone(user, resourceType, id, body.reason)
  }

  // 202, not 204: nothing has been destroyed. The response is the approval a second
  // administrator has 24 hours to redeem.
  @RequirePermission('platform:tenant.purge')
  @HttpCode(202)
  @Post(':resourceType/:id/purge')
  purge(
    @Param('resourceType', resourceTypeParam) resourceType: LifecycleResourceType,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(reasonRequiredSchema)) body: ReasonRequiredDto,
    @CurrentUser() user: AuthUser,
  ) {
    assertMayTouchUsers(user, resourceType, 'identity:user.lifecycle')
    return this.admin.requestPurge(user, resourceType, id, body.reason)
  }
}
