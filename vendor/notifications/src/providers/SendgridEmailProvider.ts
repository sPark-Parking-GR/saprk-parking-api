import sgMail from '@sendgrid/mail'
import type { EmailMessage, IEmailProvider } from '../IEmailProvider'
import { renderEmailBody } from '../templates'

export interface SendgridConfig {
  apiKey: string
  fromEmail: string
  fromName: string
}

export class SendgridEmailProvider implements IEmailProvider {
  readonly providerName = 'sendgrid'
  private initialized = false

  constructor(private readonly config: SendgridConfig) {}

  async send(message: EmailMessage): Promise<void> {
    if (!this.initialized) {
      sgMail.setApiKey(this.config.apiKey)
      this.initialized = true
    }

    const { html, text } = renderEmailBody(message)
    await sgMail.send({
      to: message.to,
      from: { email: this.config.fromEmail, name: this.config.fromName },
      subject: message.subject,
      html,
      text,
    })
  }
}
