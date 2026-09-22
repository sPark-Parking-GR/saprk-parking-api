import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import type { AuthUser } from '@spark/types'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { Public } from '../auth/decorators/public.decorator'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe'
import {
  startDriverCheckoutSchema,
  type StartDriverCheckoutDto,
} from './dto/driver-subscriptions-self.dto'
import { DriverSubscriptionsSelfService } from './driver-subscriptions-self.service'

/**
 * The rider's own view of driver billing. Distinct from AdminDriverSubscriptionsController in
 * both prefix and shape: everything here is scoped to the caller, and nothing here can name
 * another user — the only identity any handler reads is @CurrentUser.
 */
@Controller('driver-subscriptions')
export class DriverSubscriptionsSelfController {
  constructor(private readonly subscriptions: DriverSubscriptionsSelfService) {}

  /**
   * The upgrade screen has to render before anyone signs in, so this is deliberately open.
   * It returns published prices and perks only — the same information a pricing page would
   * carry — and never who is on which plan.
   */
  @Public()
  @Get('plans')
  listPlans() {
    return this.subscriptions.listPublicPlans()
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.subscriptions.getMySubscription(user.id)
  }

  /**
   * 20/min, matching verify-qr rather than the global 120: every call reaches an external
   * billing provider and may mint a customer there, so it is both slower and more expensive
   * than an ordinary write. A rider tapping upgrade needs a handful a minute at most.
   */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(200)
  @Post('checkout')
  checkout(
    @Body(new ZodValidationPipe(startDriverCheckoutSchema)) body: StartDriverCheckoutDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.subscriptions.startCheckout(user, body.planId)
  }
}
