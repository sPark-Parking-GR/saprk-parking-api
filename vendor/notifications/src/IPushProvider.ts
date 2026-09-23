export interface PushMessage {
  /** An Expo push token (`ExponentPushToken[...]`), not a raw FCM/APNs device token. */
  to: string
  title: string
  body: string
  data?: Record<string, unknown>
}

export interface IPushProvider {
  readonly providerName: string

  send(message: PushMessage): Promise<void>
}
