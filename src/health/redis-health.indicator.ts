import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { RedisConnection } from 'bullmq'

@Injectable()
export class RedisHealthIndicator implements OnModuleDestroy {
  private readonly logger = new Logger(RedisHealthIndicator.name)
  private readonly connection: RedisConnection

  constructor(config: ConfigService) {
    const url = new URL(config.get<string>('REDIS_URL') ?? 'redis://localhost:6379')
    this.connection = new RedisConnection({
      host: url.hostname,
      port: Number(url.port || 6379),
      username: url.username || undefined,
      password: url.password || undefined,
    })
    // RedisConnection re-emits the underlying client's 'error' event; an EventEmitter
    // with no 'error' listener throws and crashes the process, so this must stay attached.
    this.connection.on('error', (error: Error) => {
      this.logger.error(`Redis health connection error: ${error.message}`)
    })
  }

  // this.connection.client caches its resolved connection after the first successful
  // connect, so awaiting it alone would not detect a later outage. GET forces a live
  // round trip on every call.
  async checkConnection(): Promise<void> {
    const client = await this.connection.client
    await client.get('spark:health-check')
  }

  async onModuleDestroy(): Promise<void> {
    await this.connection.close()
  }
}
