import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createEmailContext } from '@spark/notifications'
import type { EmailProviderConfig } from '@spark/notifications'
import { NOTIFICATIONS_EMAIL_CONTEXT_TOKEN } from './notifications.constants'
import { NotificationsService } from './notifications.service'

function resolveEmailConfig(config: ConfigService): EmailProviderConfig {
  const provider = (config.get<string>('EMAIL_PROVIDER') ??
    'console') as EmailProviderConfig['provider']

  switch (provider) {
    case 'console':
      return { provider: 'console', config: {} }
    case 'sendgrid':
      return {
        provider: 'sendgrid',
        config: {
          apiKey: config.getOrThrow('SENDGRID_API_KEY'),
          fromEmail: config.getOrThrow('EMAIL_FROM_ADDRESS'),
          fromName: config.getOrThrow('EMAIL_FROM_NAME'),
        },
      }
    default:
      throw new Error(`Unknown EMAIL_PROVIDER: ${provider}`)
  }
}

@Module({
  providers: [
    {
      provide: NOTIFICATIONS_EMAIL_CONTEXT_TOKEN,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => createEmailContext(resolveEmailConfig(config)),
    },
    NotificationsService,
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
