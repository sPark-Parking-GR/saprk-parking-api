import { Body, Controller, Post } from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import { RequirePermission } from '../auth/decorators/require-permission.decorator'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe'
import {
  ingestRegionSchema,
  sweepSchema,
  type IngestRegionDto,
  type SweepDto,
} from './dto/ingestion.dto'
import { IngestionService } from './ingestion.service'
import { RefreshService } from './refresh.service'

// Every route here rewrites the shared facility catalogue, so the gate is declared once on
// the controller: a route added later is covered by default rather than by remembering to.
@RequirePermission('platform:tenant.write')
@Controller('ingestion')
export class IngestionController {
  constructor(
    private readonly ingestion: IngestionService,
    private readonly refresh: RefreshService,
  ) {}

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('osm/region')
  ingestRegion(@Body(new ZodValidationPipe(ingestRegionSchema)) body: IngestRegionDto) {
    return this.ingestion.enqueueRegion(body)
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('google/region')
  ingestGoogleRegion(@Body(new ZodValidationPipe(ingestRegionSchema)) body: IngestRegionDto) {
    return this.ingestion.enqueueGoogleRegion(body)
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('sweep')
  sweep(@Body(new ZodValidationPipe(sweepSchema)) body: SweepDto) {
    return this.ingestion.enqueueSweep(body)
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('promote')
  promote() {
    return this.ingestion.enqueuePromotion()
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('reclassify')
  reclassify() {
    return this.ingestion.enqueueReclassify()
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('refresh')
  refreshGoogle() {
    return this.refresh.enqueue()
  }
}
