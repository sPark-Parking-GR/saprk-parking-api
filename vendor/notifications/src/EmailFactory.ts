import { EmailContext } from './EmailContext'
import type { IEmailProvider } from './IEmailProvider'
import { ConsoleEmailProvider } from './providers/ConsoleEmailProvider'
import { SendgridEmailProvider } from './providers/SendgridEmailProvider'
import type { SendgridConfig } from './providers/SendgridEmailProvider'

export type EmailProviderConfig =
  | { provider: 'console'; config: Record<string, never> }
  | { provider: 'sendgrid'; config: SendgridConfig }

export function createEmailProvider(options: EmailProviderConfig): IEmailProvider {
  switch (options.provider) {
    case 'console':
      return new ConsoleEmailProvider()
    case 'sendgrid':
      return new SendgridEmailProvider(options.config)
  }
}

export function createEmailContext(options: EmailProviderConfig): EmailContext {
  return new EmailContext(createEmailProvider(options))
}
