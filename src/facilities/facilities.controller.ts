import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import type { AuthUser } from '@spark/types'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { Roles } from '../auth/decorators/roles.decorator'
import { Public } from '../auth/decorators/public.decorator'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe'
import { FacilitiesService } from './facilities.service'
import {
  adminMapSchema,
  bulkFacilitySchema,
  createFacilitySchema,
  listFacilitiesSchema,
  quoteSchema,
  searchFacilitiesSchema,
  updateFacilitySchema,
  type AdminMapDto,
  type BulkFacilityDto,
  type CreateFacilityDto,
  type ListFacilitiesDto,
  type QuoteDto,
  type SearchFacilitiesDto,
  type UpdateFacilityDto,
} from './dto/facility.dto'

@Controller('facilities')
export class FacilitiesController {
  constructor(private readonly facilities: FacilitiesService) {}

  @Public()
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
    })
  }

  @Roles('operator_staff', 'operator_admin', 'platform_admin')
  @Get()
  list(
    @Query(new ZodValidationPipe(listFacilitiesSchema)) query: ListFacilitiesDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.facilities.adminList(user, query)
  }

  @Roles('operator_staff', 'operator_admin', 'platform_admin')
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

  @Roles('operator_staff', 'operator_admin', 'platform_admin')
  @Get(':id/manage')
  manage(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.facilities.adminGetById(user, id)
  }

  @Roles('operator_admin', 'platform_admin')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Patch('bulk')
  bulk(
    @Body(new ZodValidationPipe(bulkFacilitySchema)) body: BulkFacilityDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.facilities.bulkUpdate(user, body)
  }

  @Roles('operator_admin', 'platform_admin')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post()
  create(
    @Body(new ZodValidationPipe(createFacilitySchema)) body: CreateFacilityDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.facilities.create(user, body)
  }

  @Roles('operator_admin', 'platform_admin')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateFacilitySchema)) body: UpdateFacilityDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.facilities.update(user, id, body)
  }

  @Roles('operator_admin', 'platform_admin')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.facilities.softDelete(user, id)
  }

  @Public()
  @Get(':id')
  getDetail(@Param('id') id: string) {
    return this.facilities.getDetail(id)
  }

  @Public()
  @Get(':id/quote')
  getQuote(
    @Param('id') id: string,
    @Query(new ZodValidationPipe(quoteSchema)) query: QuoteDto,
  ) {
    return this.facilities.getQuote(id, query.startsAt, query.endsAt, query.vehicleType)
  }
}
