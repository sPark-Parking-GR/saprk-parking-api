import { Controller, Get, Param, Query } from '@nestjs/common'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe'
import { Public } from '../auth/decorators/public.decorator'
import { FacilitiesService } from './facilities.service'
import {
  quoteSchema,
  searchFacilitiesSchema,
  type QuoteDto,
  type SearchFacilitiesDto,
} from './dto/facility.dto'

@Controller('facilities')
export class FacilitiesController {
  constructor(private readonly facilities: FacilitiesService) {}

  @Public()
  @Get('search')
  search(@Query(new ZodValidationPipe(searchFacilitiesSchema)) query: SearchFacilitiesDto) {
    return this.facilities.search({
      lat: query.lat,
      lng: query.lng,
      radiusMeters: query.radiusMeters,
      startsAt: query.startsAt,
      endsAt: query.endsAt,
      vehicleType: query.vehicleType,
    })
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
