import type { IncomingMessage } from 'http'
import pino from 'pino'
import { createPinoHttpOptions, REQUEST_ID_HEADER } from './logging.config'

const SENSITIVE_BODY_KEYS = [
  'password',
  'newPassword',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'clientSecret',
  'tokenHash',
  'qrSecret',
  'email',
]

function redactPaths(nodeEnv = 'test'): string[] {
  const { redact } = createPinoHttpOptions(nodeEnv)
  return (redact as { paths: string[] }).paths
}

function makeRequest(
  url: string,
  headers: Record<string, string | string[]> = {},
): IncomingMessage {
  return { url, headers } as unknown as IncomingMessage
}

describe('createPinoHttpOptions', () => {
  it('redacts the sensitive request/response headers', () => {
    const paths = redactPaths()

    expect(paths).toEqual(
      expect.arrayContaining([
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        'req.headers["stripe-signature"]',
      ]),
    )
  })

  it('does not redact the idempotency-key header', () => {
    const paths = redactPaths()

    expect(paths.some((path) => path.toLowerCase().includes('idempotency'))).toBe(false)
  })

  it('redacts every sensitive body/property key at the root, under req.body, and one level deep', () => {
    const paths = redactPaths()

    for (const key of SENSITIVE_BODY_KEYS) {
      expect(paths).toContain(key)
      expect(paths).toContain(`req.body.${key}`)
      expect(paths).toContain(`*.${key}`)
    }
  })

  it('redacts a sample log object containing an authorization header and a password', () => {
    const chunks: string[] = []
    const options = createPinoHttpOptions('test')
    const logger = pino(
      { redact: options.redact },
      { write: (chunk: string) => chunks.push(chunk) },
    )

    logger.info({
      req: { headers: { authorization: 'Bearer s3cr3t', cookie: 'sid=abc123' } },
      password: 'hunter2',
      accessToken: 'raw-access-token',
    })

    expect(chunks).toHaveLength(1)
    const logged = JSON.parse(chunks[0] as string)
    expect(logged.req.headers.authorization).toBe('[REDACTED]')
    expect(logged.req.headers.cookie).toBe('[REDACTED]')
    expect(logged.password).toBe('[REDACTED]')
    expect(logged.accessToken).toBe('[REDACTED]')
  })

  it('uses the pino-pretty transport outside production', () => {
    expect(createPinoHttpOptions('development').transport).toBeDefined()
    expect(createPinoHttpOptions('test').transport).toBeDefined()
  })

  it('omits the transport in production so pino-pretty is never required at runtime', () => {
    expect(createPinoHttpOptions('production').transport).toBeUndefined()
  })

  describe('genReqId', () => {
    it('accepts a well-formed inbound x-request-id', () => {
      const { genReqId } = createPinoHttpOptions('test')
      const req = makeRequest('/api/v1/bookings', { [REQUEST_ID_HEADER]: 'abc-123_XYZ' })

      expect(genReqId?.(req, {} as never)).toBe('abc-123_XYZ')
    })

    it('generates its own id when the header is absent', () => {
      const { genReqId } = createPinoHttpOptions('test')
      const req = makeRequest('/api/v1/bookings')

      const id = genReqId?.(req, {} as never)
      expect(typeof id).toBe('string')
      expect((id as string).length).toBeGreaterThan(0)
    })

    it('rejects an inbound id that is too long or has an unsafe charset', () => {
      const { genReqId } = createPinoHttpOptions('test')
      const tooLong = makeRequest('/api/v1/bookings', {
        [REQUEST_ID_HEADER]: 'a'.repeat(101),
      })
      const unsafe = makeRequest('/api/v1/bookings', {
        [REQUEST_ID_HEADER]: 'abc\n123',
      })

      expect(genReqId?.(tooLong, {} as never)).not.toBe('a'.repeat(101))
      expect(genReqId?.(unsafe, {} as never)).not.toBe('abc\n123')
    })
  })

  describe('autoLogging.ignore', () => {
    it('ignores the health and readiness endpoints', () => {
      const { autoLogging } = createPinoHttpOptions('test')
      const ignore = (autoLogging as { ignore: (req: IncomingMessage) => boolean }).ignore

      expect(ignore(makeRequest('/api/v1/health'))).toBe(true)
      expect(ignore(makeRequest('/api/v1/ready'))).toBe(true)
      expect(ignore(makeRequest('/api/v1/ready?verbose=1'))).toBe(true)
    })

    it('does not ignore other routes', () => {
      const { autoLogging } = createPinoHttpOptions('test')
      const ignore = (autoLogging as { ignore: (req: IncomingMessage) => boolean }).ignore

      expect(ignore(makeRequest('/api/v1/bookings'))).toBe(false)
      expect(ignore(makeRequest('/api/v1/payments/webhook'))).toBe(false)
    })
  })
})
