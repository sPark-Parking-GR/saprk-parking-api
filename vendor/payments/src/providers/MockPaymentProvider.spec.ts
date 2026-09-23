import { MockPaymentProvider } from './MockPaymentProvider'

describe('MockPaymentProvider', () => {
  let provider: MockPaymentProvider

  beforeEach(() => {
    provider = new MockPaymentProvider()
  })

  it('creates a payment intent in requires_payment state with a client secret', async () => {
    const intent = await provider.createPaymentIntent({
      amountCents: 1500,
      currency: 'EUR',
      idempotencyKey: 'idem-1',
    })

    expect(intent.status).toBe('requires_payment')
    expect(intent.amountCents).toBe(1500)
    expect(intent.clientSecret).toContain('_secret_mock')
  })

  it('is idempotent on the idempotency key', async () => {
    const first = await provider.createPaymentIntent({
      amountCents: 1500,
      currency: 'EUR',
      idempotencyKey: 'idem-2',
    })
    const second = await provider.createPaymentIntent({
      amountCents: 1500,
      currency: 'EUR',
      idempotencyKey: 'idem-2',
    })

    expect(second.providerPaymentId).toBe(first.providerPaymentId)
  })

  it('captures a payment to succeeded', async () => {
    const intent = await provider.createPaymentIntent({
      amountCents: 800,
      currency: 'EUR',
      idempotencyKey: 'idem-3',
    })

    const captured = await provider.capturePayment({ providerPaymentId: intent.providerPaymentId })
    expect(captured.status).toBe('succeeded')
    await expect(provider.getPaymentStatus(intent.providerPaymentId)).resolves.toBe('succeeded')
  })

  it('throws when capturing an unknown payment', async () => {
    await expect(provider.capturePayment({ providerPaymentId: 'nope' })).rejects.toThrow()
  })

  it('refunds a captured payment', async () => {
    const intent = await provider.createPaymentIntent({
      amountCents: 2000,
      currency: 'EUR',
      idempotencyKey: 'idem-4',
    })
    await provider.capturePayment({ providerPaymentId: intent.providerPaymentId })

    const refund = await provider.refund({
      providerPaymentId: intent.providerPaymentId,
      amountCents: 2000,
      idempotencyKey: 'ref-1',
    })

    expect(refund.status).toBe('succeeded')
    expect(refund.amountCents).toBe(2000)
  })

  describe('verifyWebhook', () => {
    const secret = 'whsec_mock'
    const payload = JSON.stringify({
      providerPaymentId: 'mock_pi_x',
      status: 'succeeded',
      type: 'payment.succeeded',
    })
    let signed: MockPaymentProvider

    beforeEach(() => {
      signed = new MockPaymentProvider({ webhookSecret: secret })
    })

    it('parses a correctly signed payload into a normalized event', () => {
      const event = signed.verifyWebhook(payload, MockPaymentProvider.sign(payload, secret))

      expect(event.providerPaymentId).toBe('mock_pi_x')
      expect(event.status).toBe('succeeded')
    })

    it('rejects a signature produced with a different secret', () => {
      const forged = MockPaymentProvider.sign(payload, 'whsec_attacker')

      expect(() => signed.verifyWebhook(payload, forged)).toThrow(/signature mismatch/)
    })

    it('rejects a payload tampered with after signing', () => {
      const signature = MockPaymentProvider.sign(payload, secret)
      const tampered = JSON.stringify({
        providerPaymentId: 'mock_pi_attacker',
        status: 'succeeded',
        type: 'payment.succeeded',
      })

      expect(() => signed.verifyWebhook(tampered, signature)).toThrow(/signature mismatch/)
    })

    it('rejects a missing signature', () => {
      expect(() => signed.verifyWebhook(payload, '')).toThrow(/signature mismatch/)
    })

    it('refuses to verify when no secret is configured', () => {
      expect(() => provider.verifyWebhook(payload, MockPaymentProvider.sign(payload, ''))).toThrow(
        /not configured/,
      )
    })
  })
})
