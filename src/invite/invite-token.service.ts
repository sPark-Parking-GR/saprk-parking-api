import { createHash, randomBytes } from 'crypto'
import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

const TOKEN_BYTES = 32

export interface MintedToken {
  /** Leaves the system only through the email channel. Never persisted, never returned. */
  rawToken: string
  tokenHash: string
  expiresAt: Date
}

/**
 * One implementation of invite-token mechanics, shared by every invite family.
 *
 * Extracted rather than copied because the properties that make a token safe — 256 bits of
 * entropy, only the sha256 hash at rest, an expiry the issuer cannot extend — are exactly
 * the kind that rot when a second copy drifts from the first.
 */
@Injectable()
export class InviteTokenService {
  constructor(private readonly config: ConfigService) {}

  mint(ttlMs: number): MintedToken {
    const rawToken = randomBytes(TOKEN_BYTES).toString('hex')
    return {
      rawToken,
      tokenHash: this.hash(rawToken),
      expiresAt: new Date(Date.now() + ttlMs),
    }
  }

  hash(token: string): string {
    return createHash('sha256').update(token).digest('hex')
  }

  /**
   * The raw token's only exit from the system. `getOrThrow` rather than `get`: a link built
   * against an undefined base URL is an invite nobody can ever redeem, and failing at boot
   * beats mailing out dead links.
   */
  acceptUrl(path: string, rawToken: string): string {
    return `${this.config.getOrThrow<string>('WEB_APP_URL')}${path}/${rawToken}`
  }
}
