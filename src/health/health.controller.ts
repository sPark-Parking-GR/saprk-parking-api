import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common'
import { SkipThrottle } from '@nestjs/throttler'
import { Public } from '../auth/decorators/public.decorator'
import { HealthService } from './health.service'
import type { ReadinessResult } from './health.service'

@Controller()
@Public()
@SkipThrottle()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('health')
  liveness(): { status: 'ok' } {
    return { status: 'ok' }
  }

  @Get('ready')
  async readiness(): Promise<ReadinessResult> {
    const result = await this.health.checkReadiness()
    if (result.status !== 'ok') {
      throw new HttpException(result, HttpStatus.SERVICE_UNAVAILABLE)
    }
    return result
  }
}
