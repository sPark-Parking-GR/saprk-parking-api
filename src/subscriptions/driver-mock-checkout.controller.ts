import { Controller, Get, NotFoundException, Param, Post, Res } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { FastifyReply } from 'fastify'
import type { MockCheckoutView, MockSubscriptionBillingProvider } from '@spark/subscription-billing'
import { Public } from '../auth/decorators/public.decorator'
import { SubscriptionBillingService } from '../subscription-billing/subscription-billing.service'
import { CHECKOUT_SUCCESS_URL } from './driver-subscriptions-self.service'
import { DriverSubscriptionEventsService } from './driver-subscription-events.service'

/**
 * `default-src 'none'` from @fastify/helmet is correct for a pure JSON API and fatal for the
 * one HTML page it serves: `form-action` and `style-src` both fall back to it, so the buttons
 * below would not submit and the page would render unstyled. Relaxed for this response only,
 * and no further — scripts and every remote origin stay blocked.
 *
 * `form-action` governs the WHOLE redirect chain a submission ends in, not just the POST
 * target: confirm/cancel land the browser on the app's own custom scheme
 * (`CHECKOUT_SUCCESS_URL`/`CHECKOUT_CANCEL_URL`, not an https origin — this is a mobile deep
 * link, not the web app), so that scheme must be allowed here too, or the browser blocks its
 * own server's redirect after a successful confirm. Derived from the same constant the
 * redirect targets come from, not hardcoded twice.
 */
const CHECKOUT_RETURN_SCHEME = new URL(CHECKOUT_SUCCESS_URL).protocol
const MOCK_PAGE_CSP = `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${CHECKOUT_RETURN_SCHEME}`

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] as string)
}

function formatPrice(priceCents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(priceCents / 100)
  } catch {
    // An unrecognised currency code must not take the page down; the number is what matters.
    return `${(priceCents / 100).toFixed(2)} ${currency}`
  }
}

/**
 * The stand-in for a hosted checkout page, and the ONLY thing in this codebase that renders
 * HTML. It exists so the whole driver-billing round trip — session, payment, webhook event,
 * subscription write — can be exercised locally without a Stripe account and without the
 * self-signed HTTP call a real webhook redelivery would need.
 *
 * Every route answers 404 unless the configured provider is `mock`. That is checked against
 * configuration explicitly AND through getMockProvider(), because the two failures deserve
 * different diagnoses: a mock page rendered against a real Stripe session id is a security
 * problem, while a misconfigured environment is an operational one.
 */
@Controller('driver-subscriptions/mock-checkout')
export class DriverMockCheckoutController {
  constructor(
    private readonly config: ConfigService,
    private readonly billing: SubscriptionBillingService,
    private readonly events: DriverSubscriptionEventsService,
  ) {}

  @Public()
  @Get(':sessionId')
  show(@Param('sessionId') sessionId: string, @Res() reply: FastifyReply): void {
    const session = this.mockProvider().getCheckoutSession(sessionId)
    if (!session) throw new NotFoundException('Unknown checkout session')

    void reply
      .header('content-security-policy', MOCK_PAGE_CSP)
      .type('text/html; charset=utf-8')
      .send(this.page(sessionId, session))
  }

  /**
   * Feeds the mock provider's event into the SAME DriverSubscriptionEventsService a real
   * Stripe delivery reaches. That is the point of this route: the mock path exercises the
   * production event handler, including its idempotency gate, rather than a shortcut that
   * would let the handler rot untested until the first real webhook arrived.
   */
  @Public()
  @Post(':sessionId/confirm')
  async confirm(@Param('sessionId') sessionId: string, @Res() reply: FastifyReply): Promise<void> {
    const provider = this.mockProvider()
    const session = provider.getCheckoutSession(sessionId)
    if (!session) throw new NotFoundException('Unknown checkout session')

    // Guarded rather than trusting the page: the mock provider throws on a second
    // completion, and a double-submitted form must land the rider back at the app instead of
    // on a 500.
    if (session.status === 'open') {
      await this.events.process(provider.completeCheckoutSession(sessionId))
    }

    void reply.redirect(session.successUrl, 302)
  }

  @Public()
  @Post(':sessionId/cancel')
  cancel(@Param('sessionId') sessionId: string, @Res() reply: FastifyReply): void {
    const provider = this.mockProvider()
    const session = provider.getCheckoutSession(sessionId)
    if (!session) throw new NotFoundException('Unknown checkout session')

    if (session.status === 'open') provider.cancelCheckoutSession(sessionId)

    void reply.redirect(session.cancelUrl, 302)
  }

  private mockProvider(): MockSubscriptionBillingProvider {
    if (this.config.get<string>('SUBSCRIPTION_BILLING_PROVIDER') !== 'mock') {
      throw new NotFoundException('Mock checkout is not available on this deployment')
    }
    const provider = this.billing.getMockProvider()
    if (!provider) throw new NotFoundException('Mock checkout is not available on this deployment')
    return provider
  }

  private page(sessionId: string, session: MockCheckoutView): string {
    const price = escapeHtml(formatPrice(session.priceCents, session.currency))
    const interval = session.interval === 'YEARLY' ? 'year' : 'month'
    const plan = escapeHtml(session.planCode)

    // Already settled: the mock provider throws on a second completion, and a page that
    // still offered the button would be inviting the user into that error.
    const action =
      session.status === 'open'
        ? `<form method="post" action="${escapeHtml(sessionId)}/confirm">
             <button type="submit" class="primary">Confirm subscription (mock)</button>
           </form>
           <form method="post" action="${escapeHtml(sessionId)}/cancel">
             <button type="submit">Cancel</button>
           </form>`
        : `<p class="settled">This checkout session is already ${escapeHtml(session.status)}.</p>`

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mock checkout — ${plan}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 2rem 1rem; background: #f5f5f7; color: #1c1c1e; }
  main { max-width: 26rem; margin: 0 auto; background: #fff; border-radius: 12px; padding: 1.5rem; }
  h1 { font-size: 1.1rem; margin: 0 0 .25rem; }
  .warn { font-size: .8rem; color: #8a6d00; background: #fff6d6; padding: .5rem .75rem; border-radius: 8px; }
  .price { font-size: 1.75rem; font-weight: 600; margin: 1rem 0 1.5rem; }
  .price span { font-size: .9rem; font-weight: 400; color: #6b6b70; }
  button { width: 100%; padding: .75rem; margin-bottom: .5rem; font-size: 1rem; border-radius: 8px; border: 1px solid #c7c7cc; background: #fff; cursor: pointer; }
  button.primary { background: #0a84ff; border-color: #0a84ff; color: #fff; }
  .settled { color: #6b6b70; }
</style>
</head>
<body>
<main>
  <p class="warn">Mock checkout. No payment is taken and no card is collected.</p>
  <h1>${plan}</h1>
  <p class="price">${price} <span>per ${interval}</span></p>
  ${action}
</main>
</body>
</html>`
  }
}
