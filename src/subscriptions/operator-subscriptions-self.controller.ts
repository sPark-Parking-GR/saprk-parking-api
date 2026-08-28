import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import type { AuthUser } from '@spark/types'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { Public } from '../auth/decorators/public.decorator'
import { RequireOrgPermission } from '../auth/decorators/require-org-permission.decorator'
import { Roles } from '../auth/decorators/roles.decorator'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe'
import {
  requestOperatorUpgradeSchema,
  startOperatorCheckoutSchema,
  type RequestOperatorUpgradeDto,
  type StartOperatorCheckoutDto,
} from './dto/operator-subscriptions-self.dto'
import { OperatorSubscriptionsSelfService } from './operator-subscriptions-self.service'

/**
 * An operator's own view of their plan. Distinct from AdminSubscriptionsController in both
 * prefix and shape: no handler here takes an operator id, so the only tenant any of them can
 * reach is the caller's own.
 *
 * The decorators sit on the handlers rather than the class so the public catalog route stays
 * genuinely public — a class-level @Roles would reach it too, and refuse the anonymous caller
 * @Public just admitted.
 *
 * Platform roles are deliberately absent from @Roles: they hold no membership, so "my
 * operator" names nothing for them, and their view of any tenant is
 * GET admin/subscriptions/operators/:operatorId.
 */
@Controller('operator-subscriptions')
export class OperatorSubscriptionsSelfController {
  constructor(private readonly subscriptions: OperatorSubscriptionsSelfService) {}

  /**
   * The pricing page has to render before anyone signs in, so this is deliberately open. It
   * returns published prices and terms only — the same information a brochure carries — and
   * never who is on which plan.
   */
  @Public()
  @Get('plans')
  listPlans() {
    return this.subscriptions.listPublicPlans()
  }

  @Roles('operator_admin')
  @RequireOrgPermission('org:billing.view')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.subscriptions.getMySubscription(user)
  }

  /**
   * The self-serve upgrade, and the primary path for any plan an operator may buy unattended.
   * `upgrade-request` below remains for the rest — sales-negotiated tiers, and "call me".
   *
   * Same gate as the whole surface, and for a stronger reason than upgrade-request's: this
   * route changes no billing state either. It opens a session at the provider and returns a
   * URL; the subscription is written only when the webhook says the money moved. Inventing an
   * `org:billing.manage` scope for it would mean an operator's own owner could be configured
   * out of paying sPark, and would hand STAFF a billing-adjacent scope that
   * STAFF_FORBIDDEN_SCOPES exists to keep them out of.
   *
   * 20/min, matching the driver checkout rather than the global 120: every call reaches an
   * external billing provider and may mint a customer there, so it is both slower and more
   * expensive than an ordinary write.
   */
  @Roles('operator_admin')
  @RequireOrgPermission('org:billing.view')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(200)
  @Post('checkout')
  checkout(
    @Body(new ZodValidationPipe(startOperatorCheckoutSchema)) body: StartOperatorCheckoutDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.subscriptions.startCheckout(user, body)
  }

  /**
   * Gated on `org:billing.view` despite being a POST, and the reason is what the route does:
   * it changes no billing state. A platform administrator still applies every plan change by
   * hand, so this signals a wish rather than exercising a write — exactly the boundary
   * `org:billing.view`'s "never write — billing is changed by sPark" describes. Inventing an
   * `org:billing.request` scope would mean an operator's own owner could be configured out of
   * asking to spend more money, and would hand STAFF a billing-adjacent scope that
   * STAFF_FORBIDDEN_SCOPES exists to keep them out of.
   *
   * 10/min, matching invite resend: same shape of endpoint — low frequency, writes a record
   * and sends mail to an address the caller does not choose.
   */
  @Roles('operator_admin')
  @RequireOrgPermission('org:billing.view')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('upgrade-request')
  requestUpgrade(
    @Body(new ZodValidationPipe(requestOperatorUpgradeSchema)) body: RequestOperatorUpgradeDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.subscriptions.requestUpgrade(user, body)
  }
}
