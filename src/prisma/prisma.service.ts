import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'
import { auditIpExtension } from './audit-ip.extension'
import { facilityClusterInvalidationExtension } from './facility-cluster-invalidation.extension'
import { lifecycleExtension } from './lifecycle.extension'

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name)
  private readonly baseDelayMs = Number(process.env['DB_CONNECT_RETRY_BASE_MS'] ?? 1000)
  private readonly maxDelayMs = Number(process.env['DB_CONNECT_RETRY_MAX_MS'] ?? 30000)
  private readonly factor = Number(process.env['DB_CONNECT_RETRY_FACTOR'] ?? 2)

  private connected = false
  private retryTimer: NodeJS.Timeout | null = null

  // Constructor-return swap: every injection of PrismaService dispatches through the
  // lifecycle extension (see lifecycle.extension.ts for exactly what it does and does
  // not cover), so no call site can forget the filter. The extended client proxies the
  // original instance, so the Nest lifecycle hooks and retry state below keep working.
  //
  // Chained, not merged: extensions apply outermost-last, so the cluster invalidation
  // sees the args the lifecycle filter already rewrote — which is what it wants, since it
  // only reacts to the write actually sent to the database.
  constructor() {
    super()
    return this.$extends(lifecycleExtension)
      .$extends(facilityClusterInvalidationExtension)
      .$extends(auditIpExtension) as unknown as this
  }

  async onModuleInit() {
    await this.connectWithRetry()
  }

  async onModuleDestroy() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    await this.$disconnect()
  }

  get isConnected() {
    return this.connected
  }

  private async connectWithRetry(attempt = 0): Promise<void> {
    try {
      await this.$connect()
      this.connected = true
      this.retryTimer = null
      if (attempt > 0) {
        this.logger.log(`Database connected after ${attempt} retr${attempt === 1 ? 'y' : 'ies'}`)
      }
    } catch (error) {
      const delay = Math.min(this.baseDelayMs * this.factor ** attempt, this.maxDelayMs)
      this.logger.error(
        `Database connection failed (attempt ${attempt + 1}). Retrying in ${delay}ms`,
        error instanceof Error ? error.message : String(error),
      )
      this.retryTimer = setTimeout(() => {
        void this.connectWithRetry(attempt + 1)
      }, delay)
    }
  }
}
