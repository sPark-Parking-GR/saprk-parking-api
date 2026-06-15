import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { ConsoleNotificationProvider } from './providers/console-notification.provider'
import type { BookingNotificationData, INotificationProvider } from './notification.types'

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name)
  private readonly provider: INotificationProvider

  constructor(config: ConfigService) {
    const name = config.get<string>('NOTIFICATION_PROVIDER') ?? 'console'
    this.provider = this.resolveProvider(name)
  }

  async sendBookingConfirmation(data: BookingNotificationData): Promise<void> {
    await this.safeSend(() => this.provider.sendBookingConfirmation(data), 'confirmation')
  }

  async sendBookingCancellation(data: BookingNotificationData): Promise<void> {
    await this.safeSend(() => this.provider.sendBookingCancellation(data), 'cancellation')
  }

  private resolveProvider(name: string): INotificationProvider {
    switch (name) {
      case 'console':
        return new ConsoleNotificationProvider()
      default:
        throw new Error(`Unknown NOTIFICATION_PROVIDER: ${name}`)
    }
  }

  private async safeSend(fn: () => Promise<void>, kind: string): Promise<void> {
    try {
      await fn()
    } catch (error) {
      this.logger.error(
        `Failed to send ${kind} notification: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}
