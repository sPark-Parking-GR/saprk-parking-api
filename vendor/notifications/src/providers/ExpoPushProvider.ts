import type { IPushProvider, PushMessage } from '../IPushProvider'

export interface ExpoPushConfig {
  /**
   * Optional Expo access token for "enhanced security" push sending. Unlike email
   * providers, Expo's push API accepts unauthenticated requests by default — the token
   * only tightens delivery to accounts that have opted into requiring it.
   */
  accessToken?: string
}

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'

interface ExpoPushTicket {
  status: 'ok' | 'error'
  id?: string
  message?: string
  details?: { error?: string }
}

export class ExpoPushProvider implements IPushProvider {
  readonly providerName = 'expo'

  constructor(private readonly config: ExpoPushConfig = {}) {}

  async send(message: PushMessage): Promise<void> {
    const response = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(this.config.accessToken ? { Authorization: `Bearer ${this.config.accessToken}` } : {}),
      },
      body: JSON.stringify({
        to: message.to,
        title: message.title,
        body: message.body,
        data: message.data,
      }),
    })

    if (!response.ok) {
      throw new Error(`Expo push API responded ${response.status}`)
    }

    // Expo returns 200 with a per-message ticket even when the SEND itself failed (e.g. an
    // unregistered or malformed token) — the HTTP status alone does not tell success apart
    // from failure.
    const body = (await response.json()) as { data?: ExpoPushTicket | ExpoPushTicket[] }
    const ticket = Array.isArray(body.data) ? body.data[0] : body.data
    if (ticket?.status !== 'ok') {
      throw new Error(
        `Expo push rejected: ${ticket?.details?.error ?? ticket?.message ?? 'unknown error'}`,
      )
    }
  }
}
