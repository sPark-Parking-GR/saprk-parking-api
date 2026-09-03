import { Inject, Injectable, Logger } from '@nestjs/common'
import type { EmailContext, PushContext } from '@spark/notifications'
import { NOTIFICATIONS_EMAIL_CONTEXT_TOKEN, NOTIFICATIONS_PUSH_CONTEXT_TOKEN } from './notifications.constants'
import type { BookingNotificationData } from './notification.types'
import { PrismaService } from '../prisma/prisma.service'

// en-GB to match the date formatting the templates already use, so one email does not
// present its money and its dates in two different conventions.
function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(cents / 100)
}

function formatStart(startsAt: Date): string {
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(
    startsAt,
  )
}

// ESP failures (SendGrid/Postmark) routinely echo the recipient address back in
// error.message; redact-by-key can't reach text embedded inside a message, so it is
// scrubbed before the error ever reaches the logger.
const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]+/g

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name)

  constructor(
    @Inject(NOTIFICATIONS_EMAIL_CONTEXT_TOKEN) private readonly emailContext: EmailContext,
    @Inject(NOTIFICATIONS_PUSH_CONTEXT_TOKEN) private readonly pushContext: PushContext,
    private readonly prisma: PrismaService,
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

  // The mobile-app sibling of sendBookingConfirmation. A driver who never installed the
  // app, or installed it but never opted into notifications, simply has no MobileProfile
  // row or no pushToken on it — that is not a failure, just nothing to send.
  async sendBookingConfirmationPush(data: BookingNotificationData): Promise<boolean> {
    const profile = await this.prisma.mobileProfile.findUnique({
      where: { userId: data.recipientUserId },
      select: { pushToken: true },
    })
    if (!profile?.pushToken) return true

    return this.safeSend(
      () =>
        this.pushContext.send({
          to: profile.pushToken!,
          title: 'Booking confirmed',
          body: `${data.facilityName} — ${formatStart(data.startsAt)}`,
          data: { type: 'booking', bookingId: data.bookingId },
        }),
      'confirmation push',
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
  async sendOperatorInvite(data: { to: string; acceptUrl: string }): Promise<boolean> {
    return this.safeSend(
      () =>
        this.emailContext.send({
          to: data.to,
          subject: `You're invited to sPark`,
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

  // Carries who invited them, not just that someone did: a link granting platform
  // administration is exactly the kind a recipient should be able to sanity-check against a
  // name they recognise before redeeming it.
  async sendPlatformAdminInvite(data: {
    to: string
    acceptUrl: string
    invitedByName: string
  }): Promise<boolean> {
    return this.safeSend(
      () =>
        this.emailContext.send({
          to: data.to,
          subject: 'You have been invited to administer sPark',
          template: 'platform-admin-invite',
          data: { ...data },
        }),
      'platform admin invite',
    )
  }

  // Inbound rather than outbound: the recipient is sPark's own billing contact, not a
  // customer. Returns delivery success because the caller reports it back to the operator who
  // asked — a request nobody was told about should not read as one that was received.
  async sendOperatorUpgradeRequest(data: {
    to: string
    operatorName: string
    requesterName: string
    requesterEmail: string
    requestedPlanName: string | null
    message: string | null
    operatorUrl: string
  }): Promise<boolean> {
    return this.safeSend(
      () =>
        this.emailContext.send({
          to: data.to,
          subject: `Upgrade requested — ${data.operatorName}`,
          template: 'operator-upgrade-requested',
          data: { ...data },
        }),
      'operator upgrade request',
    )
  }

  // A nudge, not a refusal: the create that triggered it already succeeded, and the threshold
  // is already recorded in the audit log by the time this runs. Stays on safeSend so a
  // bounced nudge costs an email and never the write that earned it.
  async sendOperatorQuotaThreshold(data: {
    to: string
    businessName: string
    resourceLabel: string
    current: number
    limit: number
    threshold: 80 | 100
    billingUrl: string
  }): Promise<boolean> {
    const subject =
      data.threshold === 100
        ? `You have used all of your ${data.resourceLabel} — ${data.businessName}`
        : `You are close to your ${data.resourceLabel} limit — ${data.businessName}`

    return this.safeSend(
      () =>
        this.emailContext.send({
          to: data.to,
          subject,
          template: 'operator-quota-threshold',
          data: { ...data },
        }),
      'operator quota threshold',
      { threshold: data.threshold, resource: data.resourceLabel },
    )
  }

  // The only unsolicited mail in the system: nobody triggered it, it arrives on a schedule,
  // and its whole job is to make a rider notice what their plan is worth. The boolean is
  // load-bearing rather than incidental — DriverSavingsService records the period as
  // summarised only when this returns true, so a bounced nudge is retried on the next sweep
  // instead of silently consuming the rider's one slot for the window.
  //
  // The amount is formatted HERE, once, and the same string goes to the subject line and to
  // the template. Formatting it on both sides of the package boundary would let a headline
  // and a body disagree about how much someone saved.
  async sendDriverSavingsSummary(data: {
    to: string
    riderName: string | null
    savedCents: number
    currency: string
    planName: string | null
    periodStart: Date
    periodEnd: Date
  }): Promise<boolean> {
    return this.safeSend(
      () => {
        // Inside the closure so an unsupported currency code surfaces as one skipped rider
        // in the sweep's log rather than an exception out of the job processor.
        const savedFormatted = formatMoney(data.savedCents, data.currency)
        return this.emailContext.send({
          to: data.to,
          subject: `You saved ${savedFormatted} with sPark`,
          template: 'driver-savings-summary',
          data: {
            riderName: data.riderName,
            savedFormatted,
            planName: data.planName,
            periodStart: data.periodStart,
            periodEnd: data.periodEnd,
          },
        })
      },
      'driver savings summary',
      { savedCents: data.savedCents, currency: data.currency },
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
