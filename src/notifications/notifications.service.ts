import { Inject, Injectable, Logger } from '@nestjs/common'
import type { EmailContext } from '@spark/notifications'
import { NOTIFICATIONS_EMAIL_CONTEXT_TOKEN } from './notifications.constants'
import type { BookingNotificationData } from './notification.types'

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name)

  constructor(
    @Inject(NOTIFICATIONS_EMAIL_CONTEXT_TOKEN) private readonly emailContext: EmailContext,
  ) {}

  async sendBookingConfirmation(data: BookingNotificationData): Promise<void> {
    await this.safeSend(
      () =>
        this.emailContext.send({
          to: data.recipientEmail,
          subject: `Booking confirmed — ${data.facilityName}`,
          template: 'booking-confirmation',
          data: { ...data },
        }),
      'confirmation',
    )
  }

  async sendBookingCancellation(data: BookingNotificationData): Promise<void> {
    await this.safeSend(
      () =>
        this.emailContext.send({
          to: data.recipientEmail,
          subject: `Booking cancelled — ${data.facilityName}`,
          template: 'booking-cancellation',
          data: { ...data },
        }),
      'cancellation',
    )
  }

  async sendOperatorInvite(data: { to: string; businessName: string; acceptUrl: string }): Promise<void> {
    await this.safeSend(
      () =>
        this.emailContext.send({
          to: data.to,
          subject: `You're invited to sPark — ${data.businessName}`,
          template: 'operator-invite',
          data: { ...data },
        }),
      'operator invite',
    )
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
