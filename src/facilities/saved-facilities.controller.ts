import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import type { AuthUser, UserRole } from '@spark/types'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { Roles } from '../auth/decorators/roles.decorator'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe'
import { saveFacilitySchema, type SaveFacilityDto } from './dto/saved-facility.dto'
import { SavedFacilitiesService } from './saved-facilities.service'

// A bookmark hangs off an account, so every account role may hold one; there is nothing
// operator-scoped about it. Anonymous callers are excluded — there would be nowhere to
// store the bookmark.
const ACCOUNT_ROLES: UserRole[] = ['user', 'operator_staff', 'operator_admin', 'platform_admin']

@Controller('saved-facilities')
export class SavedFacilitiesController {
  constructor(private readonly saved: SavedFacilitiesService) {}

  @Roles(...ACCOUNT_ROLES)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.saved.list(user)
  }

  @Roles(...ACCOUNT_ROLES)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post()
  add(
    @Body(new ZodValidationPipe(saveFacilitySchema)) body: SaveFacilityDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.saved.add(user, body.facilityId)
  }

  @Roles(...ACCOUNT_ROLES)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Delete(':facilityId')
  @HttpCode(204)
  remove(@Param('facilityId') facilityId: string, @CurrentUser() user: AuthUser) {
    return this.saved.remove(user, facilityId)
  }
}
