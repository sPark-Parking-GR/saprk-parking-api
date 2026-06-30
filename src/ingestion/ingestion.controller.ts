import { Body, Controller, Post } from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import { Roles } from '../auth/decorators/roles.decorator'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe'
import { ingestRegionSchema, type IngestRegionDto } from './dto/ingestion.dto'
import { IngestionService } from './ingestion.service'
import { RefreshService } from './refresh.service'

@Controller('ingestion')
export class IngestionController {
  constructor(
    private readonly ingestion: IngestionService,
    private readonly refresh: RefreshService,
  ) {}

  @Roles('platform_admin')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('osm/region')
  ingestRegion(@Body(new ZodValidationPipe(ingestRegionSchema)) body: IngestRegionDto) {
    return this.ingestion.enqueueRegion(body)
  }

  @Roles('platform_admin')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('google/region')
  ingestGoogleRegion(@Body(new ZodValidationPipe(ingestRegionSchema)) body: IngestRegionDto) {
    return this.ingestion.enqueueGoogleRegion(body)
  }

  @Roles('platform_admin')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('promote')
  promote() {
    return this.ingestion.enqueuePromotion()
  }

  @Roles('platform_admin')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('refresh')
  refreshGoogle() {
    return this.refresh.enqueue()
  }
}
