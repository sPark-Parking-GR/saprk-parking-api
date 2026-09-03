import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createEmailContext, createPushContext } from '@spark/notifications'
import type { EmailProviderConfig, PushProviderConfig } from '@spark/notifications'
import {
  NOTIFICATIONS_EMAIL_CONTEXT_TOKEN,
  NOTIFICATIONS_PUSH_CONTEXT_TOKEN,
} from './notifications.constants'
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

function resolvePushConfig(config: ConfigService): PushProviderConfig {
  const provider = (config.get<string>('PUSH_PROVIDER') ??
    'console') as PushProviderConfig['provider']

  switch (provider) {
    case 'console':
      return { provider: 'console', config: {} }
    case 'expo':
      return {
        provider: 'expo',
        config: {
          // Optional even under the 'expo' strategy: Expo's push API accepts
          // unauthenticated requests by default, unlike every EMAIL_PROVIDER leg.
          ...(config.get<string>('EXPO_ACCESS_TOKEN')
            ? { accessToken: config.getOrThrow('EXPO_ACCESS_TOKEN') }
            : {}),
        },
      }
    default:
      throw new Error(`Unknown PUSH_PROVIDER: ${provider}`)
  }
}

@Module({
  providers: [
    {
      provide: NOTIFICATIONS_EMAIL_CONTEXT_TOKEN,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => createEmailContext(resolveEmailConfig(config)),
    },
    {
      provide: NOTIFICATIONS_PUSH_CONTEXT_TOKEN,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => createPushContext(resolvePushConfig(config)),
    },
    NotificationsService,
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
