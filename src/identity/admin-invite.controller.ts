import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import type { AuthUser } from '@spark/types'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { Public } from '../auth/decorators/public.decorator'
import { RequirePermission } from '../auth/decorators/require-permission.decorator'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe'
import { AdminInviteService } from './admin-invite.service'
import {
  acceptAdminInviteSchema,
  createAdminInviteSchema,
  type AcceptAdminInviteDto,
  type CreateAdminInviteDto,
} from './dto/admin-invite.dto'

/**
 * Platform administrators recruiting a peer — the one identity capability that tier holds.
 *
 * NOT mounted under `/admin/*` on purpose. AdminRouteGuard is a URL-keyed backstop that
 * requires a platform-tier role on every path beginning with `/admin/`, and the accept
 * routes are redeemed by someone who by definition has no account yet. The same reasoning
 * already puts the operator invite flow under `/invites`. Every management route here
 * carries its own @RequirePermission, so the missing backstop costs nothing.
 */
@Controller('admin-invites')
export class AdminInviteController {
  constructor(private readonly invites: AdminInviteService) {}

  @RequirePermission('identity:admin.invite')
  @Post()
  create(
    @Body(new ZodValidationPipe(createAdminInviteSchema)) body: CreateAdminInviteDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.invites.create(user, body)
  }

  @RequirePermission('identity:admin.invite')
  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.invites.list(user)
  }

  @RequirePermission('identity:admin.invite')
  @HttpCode(200)
  @Post(':id/resend')
  resend(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.invites.resend(user, id)
  }

  @RequirePermission('identity:admin.invite')
  @HttpCode(200)
  @Post(':id/revoke')
  revoke(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.invites.revoke(user, id)
  }

  // Throttled harder than the management routes: these two are the only unauthenticated way
  // to probe a token, so they are the ones worth guessing at.
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Get('token/:token')
  validate(@Param('token') token: string) {
    return this.invites.validate(token)
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(200)
  @Post('token/:token/accept')
  accept(
    @Param('token') token: string,
    @Body(new ZodValidationPipe(acceptAdminInviteSchema)) body: AcceptAdminInviteDto,
  ) {
    return this.invites.accept(token, body.password)
  }
}
