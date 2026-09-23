import type { IPushProvider, PushMessage } from '../IPushProvider'

export class ConsolePushProvider implements IPushProvider {
  readonly providerName = 'console'

  async send(message: PushMessage): Promise<void> {
    console.log(
      [
        '[ConsolePushProvider] --- push ---',
        `to:    ${message.to}`,
        `title: ${message.title}`,
        `body:  ${message.body}`,
        `data:  ${JSON.stringify(message.data ?? {}, null, 2)}`,
        '[ConsolePushProvider] -----------',
      ].join('\n'),
    )
  }
}
