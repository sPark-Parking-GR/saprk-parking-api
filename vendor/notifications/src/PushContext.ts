import type { IPushProvider, PushMessage } from './IPushProvider'

export class PushContext {
  constructor(private provider: IPushProvider) {}

  get providerName(): string {
    return this.provider.providerName
  }

  setProvider(provider: IPushProvider): void {
    this.provider = provider
  }

  send(message: PushMessage): Promise<void> {
    return this.provider.send(message)
  }
}
