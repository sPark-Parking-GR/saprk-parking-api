import { Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { RedisHealthIndicator } from './redis-health.indicator'

const CHECK_TIMEOUT_MS = 2000

export interface DependencyStatus {
  status: 'up' | 'down'
  error?: string
}

export interface ReadinessResult {
  status: 'ok' | 'error'
  checks: {
    database: DependencyStatus
    redis: DependencyStatus
  }
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisHealthIndicator,
  ) {}

  async checkReadiness(): Promise<ReadinessResult> {
    const [database, redis] = await Promise.all([this.checkDatabase(), this.checkRedis()])
    const healthy = database.status === 'up' && redis.status === 'up'
    return { status: healthy ? 'ok' : 'error', checks: { database, redis } }
  }

  private async checkDatabase(): Promise<DependencyStatus> {
    try {
      await this.withTimeout(this.prisma.$queryRaw`SELECT 1`)
      return { status: 'up' }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error'
      this.logger.error(`Database readiness check failed: ${message}`)
      return { status: 'down', error: message }
    }
  }

  private async checkRedis(): Promise<DependencyStatus> {
    try {
      await this.withTimeout(this.redis.checkConnection())
      return { status: 'up' }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error'
      this.logger.error(`Redis readiness check failed: ${message}`)
      return { status: 'down', error: message }
    }
  }

  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout
    const timeout = new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error('check timed out')), CHECK_TIMEOUT_MS)
    })
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
  }
}
