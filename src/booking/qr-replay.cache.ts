import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { RedisConnection, type IRedisClient } from 'bullmq'
import { TicketVerificationUnavailableError } from '../common/errors/domain.errors'
import { parseRedisConnection } from '../config/env.schema'

/**
 * Ten minutes, against a ±2 minute skew window. A payload minted for minute M is still
 * acceptable at server minute M+2, so its entry has to outlive that — plus room for a
 * scanner and the server disagreeing about the wall clock. Shorter risks a nonce expiring
 * while its code is still redeemable, which is exactly the replay hole the cache closes;
 * much longer only holds keys nothing can redeem any more.
 */
export const QR_REPLAY_TTL_SECONDS = 600

export const QR_CLAIM_COMMAND = 'sparkClaimQrNonce'

/**
 * SET NX EX in one round trip. Two barriers scanning the same screenshot in the same
 * second both reach Redis, and exactly one SET succeeds — a GET-then-SET would let both
 * read "unseen" and both open. Lua rather than the client's own set(): the BullMQ client
 * abstraction exposes only SET with an expiry, no NX, and NX is the entire guarantee.
 */
const QR_CLAIM_SCRIPT = `
if redis.call('SET', KEYS[1], '1', 'EX', ARGV[1], 'NX') then
  return 1
end
return 0`

export type ReplayClaim = 'claimed' | 'replayed'

@Injectable()
export class QrReplayCache implements OnModuleDestroy {
  private readonly logger = new Logger(QrReplayCache.name)
  private readonly connection: RedisConnection
  private readonly prepared = new WeakSet<IRedisClient>()

  constructor(config: ConfigService) {
    this.connection = new RedisConnection(parseRedisConnection(config.get<string>('REDIS_URL')))
    // RedisConnection re-emits the underlying client's 'error' event; an EventEmitter with
    // no 'error' listener throws and crashes the process, so this must stay attached.
    this.connection.on('error', (error: Error) => {
      this.logger.error(`QR replay cache connection error: ${error.message}`)
    })
  }

  /**
   * Marks (booking, minute) as spent. Throws when Redis cannot answer; the caller decides
   * what an unverifiable scan means and this deliberately does not decide it here.
   */
  async claim(bookingId: string, unixMinute: number): Promise<ReplayClaim> {
    const client = await this.client()
    const claimed: unknown = await client.runCommand(QR_CLAIM_COMMAND, [
      `spark:qr:seen:${bookingId}:${unixMinute}`,
      QR_REPLAY_TTL_SECONDS,
    ])

    if (claimed === 1) return 'claimed'
    if (claimed === 0) return 'replayed'
    // Neither answer means the script did not run as written. Reporting a guess would
    // either wave a replay through or reject every genuine code, so refuse instead.
    throw new TicketVerificationUnavailableError()
  }

  private async client(): Promise<IRedisClient> {
    const client = await this.connection.client
    if (!this.prepared.has(client)) {
      client.defineCommand(QR_CLAIM_COMMAND, { numberOfKeys: 1, lua: QR_CLAIM_SCRIPT })
      this.prepared.add(client)
    }
    return client
  }

  async onModuleDestroy(): Promise<void> {
    await this.connection.close()
  }
}
