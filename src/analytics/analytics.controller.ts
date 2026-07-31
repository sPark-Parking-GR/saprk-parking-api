import { Controller, ForbiddenException, Get, Query } from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import type { AuthUser, UserRole } from '@spark/types'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { Roles } from '../auth/decorators/roles.decorator'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe'
import { AnalyticsService } from './analytics.service'
import {
  analyticsSummarySchema,
  revenueSeriesSchema,
  topFacilitiesSchema,
  type AnalyticsSummaryDto,
  type RevenueSeriesDto,
  type TopFacilitiesDto,
} from './dto/analytics.dto'

const REPORTING_ROLES: UserRole[] = ['operator_staff', 'operator_admin', 'platform_admin']

// Aggregates over the whole payment history are the most expensive reads in the API and
// a dashboard fires at most a handful per page load, so they get a quarter of the untuned
// global budget rather than inheriting it.
@Throttle({ default: { limit: 30, ttl: 60_000 } })
@Roles(...REPORTING_ROLES)
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('summary')
  summary(
    @Query(new ZodValidationPipe(analyticsSummarySchema)) query: AnalyticsSummaryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.analytics.summary(this.reportingUser(user), query)
  }

  @Get('revenue-series')
  revenueSeries(
    @Query(new ZodValidationPipe(revenueSeriesSchema)) query: RevenueSeriesDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.analytics.revenueSeries(this.reportingUser(user), query)
  }

  @Get('top-facilities')
  topFacilities(
    @Query(new ZodValidationPipe(topFacilitiesSchema)) query: TopFacilitiesDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.analytics.topFacilities(this.reportingUser(user), query)
  }

  /**
   * The controller half of the authorization, and deliberately not just the @Roles
   * decorator above it. That gate is reflector metadata resolved by a global guard: a
   * refactor that drops the decorator, renames the metadata key or unregisters the guard
   * opens every one of these routes to any authenticated consumer, silently. The service
   * would still scope the money — OperatorScopeService refuses a consumer role — but the
   * two layers must fail independently for that to be a guarantee rather than a
   * coincidence, so the role set is asserted here against the request's own user.
   */
  private reportingUser(user: AuthUser): AuthUser {
    if (!REPORTING_ROLES.includes(user.role)) {
      throw new ForbiddenException('Insufficient permissions')
    }
    return user
  }
}
