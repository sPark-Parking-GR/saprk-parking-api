import { Body, Controller, HttpCode, Patch } from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import type { AuthUser } from '@spark/types'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe'
import {
  updateMobileProfileSchema,
  type UpdateMobileProfileDto,
} from './dto/mobile-profile.dto'
import { MobileProfileService } from './mobile-profile.service'

/**
 * Authenticated, and scoped to the caller's OWN row — the id comes from the verified
 * token, never from the body. Any authenticated role may hold a mobile profile: an
 * operator admin who also uses the mobile app gets one exactly like a driver does.
 */
@Controller('auth')
export class MobileProfileController {
  constructor(private readonly mobileProfile: MobileProfileService) {}

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(200)
  @Patch('mobile-profile')
  update(
    @Body(new ZodValidationPipe(updateMobileProfileSchema)) body: UpdateMobileProfileDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.mobileProfile.upsert(user.id, body)
  }
}
