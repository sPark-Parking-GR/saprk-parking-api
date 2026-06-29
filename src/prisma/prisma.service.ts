import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name)
  private readonly baseDelayMs = Number(process.env['DB_CONNECT_RETRY_BASE_MS'] ?? 1000)
  private readonly maxDelayMs = Number(process.env['DB_CONNECT_RETRY_MAX_MS'] ?? 30000)
  private readonly factor = Number(process.env['DB_CONNECT_RETRY_FACTOR'] ?? 2)

  private connected = false
  private retryTimer: NodeJS.Timeout | null = null

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
