import { PushContext } from './PushContext'
import type { IPushProvider } from './IPushProvider'
import { ConsolePushProvider } from './providers/ConsolePushProvider'
import { ExpoPushProvider } from './providers/ExpoPushProvider'
import type { ExpoPushConfig } from './providers/ExpoPushProvider'

export type PushProviderConfig =
  | { provider: 'console'; config: Record<string, never> }
  | { provider: 'expo'; config: ExpoPushConfig }

export function createPushProvider(options: PushProviderConfig): IPushProvider {
  switch (options.provider) {
    case 'console':
      return new ConsolePushProvider()
    case 'expo':
      return new ExpoPushProvider(options.config)
  }
}

export function createPushContext(options: PushProviderConfig): PushContext {
  return new PushContext(createPushProvider(options))
}
