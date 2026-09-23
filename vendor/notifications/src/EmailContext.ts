import type { EmailMessage, IEmailProvider } from './IEmailProvider'

export class EmailContext {
  constructor(private provider: IEmailProvider) {}

  get providerName(): string {
    return this.provider.providerName
  }

  setProvider(provider: IEmailProvider): void {
    this.provider = provider
  }

  send(message: EmailMessage): Promise<void> {
    return this.provider.send(message)
  }
}
