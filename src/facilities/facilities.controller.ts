import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import type { AuthUser } from '@spark/types'
import { isPlatformRole } from '@spark/types'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { RequireOrgPermission } from '../auth/decorators/require-org-permission.decorator'
import { Roles } from '../auth/decorators/roles.decorator'
import { Public } from '../auth/decorators/public.decorator'
import { FacilityFieldForbiddenError } from '../common/errors/domain.errors'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe'
import { FacilitiesService } from './facilities.service'
import {
  adminMapSchema,
  assignTariffSchema,
  bulkFacilitySchema,
  createFacilitySchema,
  deactivateFacilitySchema,
  listFacilitiesSchema,
  quoteSchema,
  searchFacilitiesSchema,
  updateFacilitySchema,
  type AdminMapDto,
  type AssignTariffDto,
  type BulkFacilityDto,
  type CreateFacilityDto,
  type DeactivateFacilityDto,
  type ListFacilitiesDto,
  type QuoteDto,
  type SearchFacilitiesDto,
  type UpdateFacilityDto,
} from './dto/facility.dto'

@Controller('facilities')
export class FacilitiesController {
  constructor(private readonly facilities: FacilitiesService) {}

  // Anonymous + heaviest public route (PostGIS + set-based availability/price computation),
  // so it gets its own budget below the untuned global 120/min rather than inheriting it.
  // 60/min (~1 req/sec) mirrors the admin `map` route's bounding-box query below and still
  // covers a user actively panning/zooming the map, which typically debounces well under 1/sec.
  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('search')
  search(@Query(new ZodValidationPipe(searchFacilitiesSchema)) query: SearchFacilitiesDto) {
    const bounds =
      query.north != null && query.south != null && query.east != null && query.west != null
        ? { north: query.north, south: query.south, east: query.east, west: query.west }
        : undefined
    return this.facilities.search({
      lat: query.lat,
      lng: query.lng,
      radiusMeters: query.radiusMeters,
      bounds,
      startsAt: query.startsAt,
      endsAt: query.endsAt,
      vehicleType: query.vehicleType,
      preferMode: query.preferMode,
    })
  }

  @Roles('operator_staff', 'operator_admin', 'platform_admin', 'super_admin')
  @RequireOrgPermission('org:facility.read')
  @Get()
  list(
    @Query(new ZodValidationPipe(listFacilitiesSchema)) query: ListFacilitiesDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.facilities.adminList(user, query)
  }

  @Roles('operator_staff', 'operator_admin', 'platform_admin', 'super_admin')
  @RequireOrgPermission('org:facility.read')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('map')
  adminMap(
    @Query(new ZodValidationPipe(adminMapSchema)) query: AdminMapDto,
    @CurrentUser() user: AuthUser,
  ) {
    const { north, south, east, west, ...filters } = query
    return this.facilities.adminMap(user, {
      bounds: { north, south, east, west },
      ...filters,
    })
  }

  @Roles('operator_staff', 'operator_admin', 'platform_admin', 'super_admin')
  @RequireOrgPermission('org:facility.read')
  @Get(':id/manage')
  manage(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.facilities.adminGetById(user, id)
  }

  @Roles('operator_admin', 'platform_admin', 'super_admin')
  @RequireOrgPermission('org:facility.write')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Patch('bulk')
  bulk(
    @Body(new ZodValidationPipe(bulkFacilitySchema)) body: BulkFacilityDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.facilities.bulkUpdate(user, body)
  }

  // `kind` decides whether a facility is sellable at all, so it is platform-only. Gated
  // here on the role and again in the service on the resolved operator scope, per the
  // both-layers rule — neither check is load-bearing alone.
  @Roles('operator_admin', 'platform_admin', 'super_admin')
  @RequireOrgPermission('org:facility.write')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post()
  create(
    @Body(new ZodValidationPipe(createFacilitySchema)) body: CreateFacilityDto,
    @CurrentUser() user: AuthUser,
  ) {
    if (body.kind !== undefined && !isPlatformRole(user.role)) {
      throw new FacilityFieldForbiddenError('kind')
    }
    return this.facilities.create(user, body)
  }

  @Roles('operator_staff', 'operator_admin', 'platform_admin', 'super_admin')
  @RequireOrgPermission('org:facility.read')
  @Get(':id/tariff-assignments')
  tariffAssignments(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.facilities.getTariffAssignments(user, id)
  }

  @Roles('operator_admin', 'platform_admin', 'super_admin')
  @RequireOrgPermission('org:facility.write')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Patch(':id/tariff-plan')
  assignTariff(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(assignTariffSchema)) body: AssignTariffDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.facilities.assignTariff(user, id, body.vehicleType, body.tariffPlanId)
  }

  // `kind` decides whether a facility is sellable at all, so it is platform-only. Gated
  // here on the role and again in the service on the resolved operator scope, per the
  // both-layers rule — neither check is load-bearing alone.
  @Roles('operator_admin', 'platform_admin', 'super_admin')
  @RequireOrgPermission('org:facility.write')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateFacilitySchema)) body: UpdateFacilityDto,
    @CurrentUser() user: AuthUser,
  ) {
    if (body.kind !== undefined && !isPlatformRole(user.role)) {
      throw new FacilityFieldForbiddenError('kind')
    }
    return this.facilities.update(user, id, body)
  }

  @Roles('operator_admin', 'platform_admin', 'super_admin')
  @RequireOrgPermission('org:facility.write')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Delete(':id')
  @HttpCode(204)
  remove(
    @Param('id') id: string,
    @Query(new ZodValidationPipe(deactivateFacilitySchema)) query: DeactivateFacilityDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.facilities.softDelete(user, id, query.force)
  }

  @Public()
  @Get(':id')
  getDetail(@Param('id') id: string) {
    return this.facilities.getDetail(id)
  }

  // Runs per user action (picking a facility, then re-quoting a few times while adjusting
  // start/end time or vehicle type) rather than per map gesture, so it warrants a lower
  // ceiling than search while still leaving room for that back-and-forth before booking.
  @Public()
  @Throttle({ default: { limit: 40, ttl: 60_000 } })
  @Get(':id/quote')
  getQuote(@Param('id') id: string, @Query(new ZodValidationPipe(quoteSchema)) query: QuoteDto) {
    return this.facilities.getQuote(id, query.startsAt, query.endsAt, query.vehicleType)
  }
}
