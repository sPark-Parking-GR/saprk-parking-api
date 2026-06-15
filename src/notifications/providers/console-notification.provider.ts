import { Logger } from '@nestjs/common'
import type { BookingNotificationData, INotificationProvider } from '../notification.types'

export class ConsoleNotificationProvider implements INotificationProvider {
  readonly providerName = 'console'

  private readonly logger = new Logger('Notification')

  async sendBookingConfirmation(data: BookingNotificationData): Promise<void> {
    this.logger.log(
      `Confirmation → ${data.recipientEmail}: booking ${data.accessCode} at ${data.facilityName}, ${data.startsAt.toISOString()}`,
    )
  }

  async sendBookingCancellation(data: BookingNotificationData): Promise<void> {
    this.logger.log(
      `Cancellation → ${data.recipientEmail}: booking ${data.accessCode} at ${data.facilityName}`,
    )
  }
}
