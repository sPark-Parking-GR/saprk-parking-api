import { NotFoundException } from '@nestjs/common'
import type { ConfigService } from '@nestjs/config'
import type { FastifyReply } from 'fastify'
import type {
  MockCheckoutView,
  MockSubscriptionBillingProvider,
  SubscriptionBillingWebhookEvent,
} from '@spark/subscription-billing'
import type { SubscriptionBillingService } from '../subscription-billing/subscription-billing.service'
import { OperatorMockCheckoutController } from './operator-mock-checkout.controller'
import type { OperatorSubscriptionEventsService } from './operator-subscription-events.service'

const SESSION: MockCheckoutView = {
  planCode: 'growth',
  priceCents: 4_900,
  currency: 'EUR',
  interval: 'MONTHLY',
  successUrl: 'http://localhost:3000/dashboard/billing?checkout=success',
  cancelUrl: 'http://localhost:3000/dashboard/billing?checkout=cancel',
  status: 'open',
}

interface ReplyStub {
  header: jest.Mock
  type: jest.Mock
  send: jest.Mock
  redirect: jest.Mock
}

function reply() {
  const sent: { body?: string; headers: Record<string, string>; redirect?: string } = {
    headers: {},
  }
  const self: ReplyStub = {
    header: jest.fn((name: string, value: string) => {
      sent.headers[name] = value
      return self
    }),
    type: jest.fn((value: string) => {
      sent.headers['content-type'] = value
      return self
    }),
    send: jest.fn((body: string) => {
      sent.body = body
      return self
    }),
    // Fastify 4.29 accepts both argument orders and deprecates (code, url); the controller
    // uses the (url, code) form v5 enforces.
    redirect: jest.fn((url: string, _code?: number) => {
      sent.redirect = url
      return self
    }),
  }
  return { reply: self as unknown as FastifyReply, sent }
}

interface Harness {
  controller: OperatorMockCheckoutController
  provider: {
    getCheckoutSession: jest.Mock
    completeCheckoutSession: jest.Mock
    cancelCheckoutSession: jest.Mock
  }
  events: { process: jest.Mock }
}

function build(
  options: { provider?: 'mock' | 'stripe'; session?: MockCheckoutView | undefined } = {},
): Harness {
  const configured = options.provider ?? 'mock'
  const provider = {
    getCheckoutSession: jest.fn().mockReturnValue('session' in options ? options.session : SESSION),
    completeCheckoutSession: jest.fn().mockReturnValue({
      id: 'evt_1',
      type: 'checkout.completed',
      eventCreatedAt: new Date('2026-08-28T12:00:00Z'),
      raw: {},
    } satisfies SubscriptionBillingWebhookEvent),
    cancelCheckoutSession: jest.fn(),
  }
  const events = { process: jest.fn().mockResolvedValue('processed') }

  const controller = new OperatorMockCheckoutController(
    {
      get: jest.fn().mockReturnValue(configured),
      getOrThrow: jest.fn().mockReturnValue('http://localhost:3011'),
    } as unknown as ConfigService,
    {
      getMockProvider: () =>
        configured === 'mock' ? (provider as unknown as MockSubscriptionBillingProvider) : null,
    } as unknown as SubscriptionBillingService,
    events as unknown as OperatorSubscriptionEventsService,
  )

  return { controller, provider, events }
}

/**
 * The whole point of this controller is that it does not exist on a deployment taking real
 * money. Rendering a fake confirmation page against a live Stripe session id, or worse
 * "completing" one, is the failure these tests are here to make impossible.
 */
describe('OperatorMockCheckoutController — refuses to exist on a real provider', () => {
  it.each(['show', 'confirm', 'cancel'] as const)(
    '404s %s when SUBSCRIPTION_BILLING_PROVIDER is stripe',
    async (handler) => {
      const { controller, provider, events } = build({ provider: 'stripe' })
      const { reply: res } = reply()

      // An async thunk, so a handler that throws synchronously is captured the same way one
      // that rejects is — the two forms are an implementation detail of each route.
      const call = async () =>
        (controller[handler] as (id: string, r: FastifyReply) => unknown)('cs_live_1', res)
      await expect(call()).rejects.toBeInstanceOf(NotFoundException)

      expect(provider.getCheckoutSession).not.toHaveBeenCalled()
      expect(provider.completeCheckoutSession).not.toHaveBeenCalled()
      expect(events.process).not.toHaveBeenCalled()
    },
  )

  it.each(['show', 'confirm', 'cancel'] as const)(
    '404s %s for an unknown session',
    async (handler) => {
      const { controller } = build({ session: undefined })
      const { reply: res } = reply()

      const call = async () =>
        (controller[handler] as (id: string, r: FastifyReply) => unknown)('cs_nope', res)
      await expect(call()).rejects.toBeInstanceOf(NotFoundException)
    },
  )
})

describe('OperatorMockCheckoutController — the page', () => {
  it('renders the plan, price and both actions, and relaxes only the CSP it needs', () => {
    const { controller } = build()
    const { reply: res, sent } = reply()

    controller.show('cs_1', res)

    expect(sent.headers['content-type']).toContain('text/html')
    expect(sent.headers['content-security-policy']).toContain("form-action 'self'")
    expect(sent.headers['content-security-policy']).toContain("default-src 'none'")
    expect(sent.body).toContain('growth')
    expect(sent.body).toContain('49.00')
    expect(sent.body).toContain('cs_1/confirm')
    expect(sent.body).toContain('cs_1/cancel')
  })

  // The mock provider throws on a second completion, so a page that still offered the button
  // would be walking the user into that error.
  it('offers no action on a session that is already settled', () => {
    const { controller } = build({ session: { ...SESSION, status: 'completed' } })
    const { reply: res, sent } = reply()

    controller.show('cs_1', res)

    expect(sent.body).not.toContain('cs_1/confirm')
    expect(sent.body).toContain('already completed')
  })

  it('escapes session-derived text rather than interpolating it into the markup', () => {
    const { controller } = build({ session: { ...SESSION, planCode: '<script>x</script>' } })
    const { reply: res, sent } = reply()

    controller.show('cs_1', res)

    expect(sent.body).not.toContain('<script>x</script>')
    expect(sent.body).toContain('&lt;script&gt;')
  })
})

describe('OperatorMockCheckoutController — confirm and cancel', () => {
  /**
   * The reason this route exists: it drives the SAME event handler a real Stripe delivery
   * reaches, in-process, so the production path is what gets exercised rather than a
   * shortcut around it — and specifically the OPERATOR handler, never the driver one.
   */
  it('feeds the provider’s event into the real event service, then returns to the dashboard', async () => {
    const { controller, provider, events } = build()
    const { reply: res, sent } = reply()

    await controller.confirm('cs_1', res)

    expect(provider.completeCheckoutSession).toHaveBeenCalledWith('cs_1')
    expect(events.process).toHaveBeenCalledWith(
      provider.completeCheckoutSession.mock.results[0]!.value,
    )
    expect(sent.redirect).toBe(SESSION.successUrl)
  })

  it('redirects a double-submitted confirm without completing the session twice', async () => {
    const { controller, provider, events } = build({
      session: { ...SESSION, status: 'completed' },
    })
    const { reply: res, sent } = reply()

    await controller.confirm('cs_1', res)

    expect(provider.completeCheckoutSession).not.toHaveBeenCalled()
    expect(events.process).not.toHaveBeenCalled()
    expect(sent.redirect).toBe(SESSION.successUrl)
  })

  it('cancels the session and returns to the dashboard’s cancel route', () => {
    const { controller, provider } = build()
    const { reply: res, sent } = reply()

    controller.cancel('cs_1', res)

    expect(provider.cancelCheckoutSession).toHaveBeenCalledWith('cs_1')
    expect(sent.redirect).toBe(SESSION.cancelUrl)
  })
})
