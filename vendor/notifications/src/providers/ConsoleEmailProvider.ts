import type { EmailMessage, IEmailProvider } from '../IEmailProvider'

export class ConsoleEmailProvider implements IEmailProvider {
  readonly providerName = 'console'

  async send(message: EmailMessage): Promise<void> {
    console.log(
      [
        '[ConsoleEmailProvider] --- email ---',
        `to:       ${message.to}`,
        `subject:  ${message.subject}`,
        `template: ${message.template}`,
        `data:     ${JSON.stringify(message.data, null, 2)}`,
        '[ConsoleEmailProvider] ------------',
      ].join('\n'),
    )
  }
}
