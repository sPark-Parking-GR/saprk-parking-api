export interface EmailMessage {
  to: string
  subject: string
  template:
    | 'operator-invite'
    | 'operator-member-invite'
    | 'platform-admin-invite'
    | 'operator-upgrade-requested'
    | 'operator-quota-threshold'
    | 'password-reset'
    | 'password-change'
    | 'booking-confirmation'
    | 'booking-cancellation'
    | 'driver-savings-summary'
  data: Record<string, unknown>
}

export interface IEmailProvider {
  readonly providerName: string

  send(message: EmailMessage): Promise<void>
}
