import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import type { AuthUser } from '@spark/types'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { Public } from '../auth/decorators/public.decorator'
import { Roles } from '../auth/decorators/roles.decorator'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe'
import {
  acceptInviteSchema,
  createInviteSchema,
  type AcceptInviteDto,
  type CreateInviteDto,
} from './dto/invite.dto'
import { InviteService } from './invite.service'

@Controller('invites')
export class InviteController {
  constructor(private readonly invites: InviteService) {}

  @Roles('platform_admin')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post()
  create(
    @Body(new ZodValidationPipe(createInviteSchema)) body: CreateInviteDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.invites.create(user, body)
  }

  @Roles('platform_admin')
  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.invites.list(user)
  }

  @Roles('platform_admin')
  @HttpCode(204)
  @Post(':id/revoke')
  revoke(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.invites.revoke(user, id)
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
    return this.invites.accept(token, body.password)
  }
}
