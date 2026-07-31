import { Inject, Injectable, Logger } from '@nestjs/common'
import type { EmailContext } from '@spark/notifications'
import { NOTIFICATIONS_EMAIL_CONTEXT_TOKEN } from './notifications.constants'
import type { BookingNotificationData } from './notification.types'

// ESP failures (SendGrid/Postmark) routinely echo the recipient address back in
// error.message; redact-by-key can't reach text embedded inside a message, so it is
// scrubbed before the error ever reaches the logger.
const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]+/g

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
      { bookingId: data.bookingId },
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
      { bookingId: data.bookingId },
    )
  }

  // Returns delivery success rather than swallowing it: the raw invite token leaves the
  // system only through this email, so a silent failure is an invite nobody can ever
  // accept. The address belongs to a third party the caller named, not to the caller, so
  // reporting the outcome tells them nothing about an account they could not already
  // enumerate — the enumeration argument that keeps sendPasswordReset silent does not
  // apply here.
  async sendOperatorInvite(data: {
    to: string
    businessName: string
    acceptUrl: string
  }): Promise<boolean> {
    return this.safeSend(
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

  async sendOperatorMemberInvite(data: {
    to: string
    businessName: string
    acceptUrl: string
    isAdmin: boolean
  }): Promise<boolean> {
    return this.safeSend(
      () =>
        this.emailContext.send({
          to: data.to,
          subject: `You're invited to join ${data.businessName} on sPark`,
          template: 'operator-member-invite',
          data: { ...data },
        }),
      'operator member invite',
    )
  }

  // Kept on safeSend like every other channel: /auth/forgot-password answers 204 whether or
  // not the address exists, so surfacing a delivery failure here would reintroduce exactly
  // the enumeration signal that endpoint is built to deny. A bounced reset is recoverable by
  // asking again; the operator sees the failure in the logs.
  async sendPasswordReset(data: { to: string; resetLink: string }): Promise<void> {
    await this.safeSend(
      () =>
        this.emailContext.send({
          to: data.to,
          subject: 'Reset your sPark password',
          template: 'password-reset',
          data: { resetLink: data.resetLink },
        }),
      'password reset',
    )
  }

  private async safeSend(
    fn: () => Promise<void>,
    kind: string,
    context: Record<string, unknown> = {},
  ): Promise<boolean> {
    try {
      await fn()
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.error(
        { kind, ...context, error: message.replace(EMAIL_PATTERN, '[REDACTED]') },
        'Failed to send notification',
      )
      return false
    }
  }
}
