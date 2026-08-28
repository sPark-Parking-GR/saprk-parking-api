import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import type { AuthUser } from '@spark/types'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { Public } from '../auth/decorators/public.decorator'
import { RequirePermission } from '../auth/decorators/require-permission.decorator'
import { Roles } from '../auth/decorators/roles.decorator'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe'
import {
  acceptInviteSchema,
  createInviteSchema,
  createMemberInviteSchema,
  type AcceptInviteDto,
  type CreateInviteDto,
  type CreateMemberInviteDto,
} from './dto/invite.dto'
import { InviteService } from './invite.service'

@Controller('invites')
export class InviteController {
  constructor(private readonly invites: InviteService) {}

  @RequirePermission('platform:role.grant')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post()
  create(
    @Body(new ZodValidationPipe(createInviteSchema)) body: CreateInviteDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.invites.create(user, body)
  }

  // Declared before @Post(':token/accept') so the literal segment is never shadowed by
  // the token parameter.
  @Roles('operator_admin', 'platform_admin', 'super_admin')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('members')
  createMember(
    @Body(new ZodValidationPipe(createMemberInviteSchema)) body: CreateMemberInviteDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.invites.createMember(user, body)
  }

  @Roles('operator_admin', 'platform_admin', 'super_admin')
  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.invites.list(user)
  }

  @Roles('operator_admin', 'platform_admin', 'super_admin')
  @HttpCode(204)
  @Post(':id/revoke')
  revoke(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.invites.revoke(user, id)
  }

  // Tighter than create: every call mints a fresh token and sends mail to an address the
  // caller chose earlier, so it is both a credential-issuing and an outbound-mail endpoint.
  @Roles('operator_admin', 'platform_admin', 'super_admin')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post(':id/resend')
  resend(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.invites.resend(user, id)
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Get(':token')
  validate(@Param('token') token: string) {
    return this.invites.validate(token)
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(200)
  @Post(':token/accept')
  accept(
    @Param('token') token: string,
    @Body(new ZodValidationPipe(acceptInviteSchema)) body: AcceptInviteDto,
  ) {
    return this.invites.accept(token, body.password, body.businessName)
  }
}
