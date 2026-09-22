import { randomUUID } from 'crypto'
import type { IncomingMessage } from 'http'
import type { Options } from 'pino-http'

export const REQUEST_ID_HEADER = 'x-request-id'

// Inbound value lands in every log line for the request, so it is constrained to a
// bounded, log-safe charset rather than trusted verbatim.
const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{1,100}$/

function genReqId(req: IncomingMessage): string {
  const inbound = req.headers[REQUEST_ID_HEADER]
  const candidate = Array.isArray(inbound) ? inbound[0] : inbound
  return candidate && REQUEST_ID_PATTERN.test(candidate) ? candidate : randomUUID()
}

function isHealthCheckPath(req: IncomingMessage): boolean {
  const path = req.url?.split('?')[0] ?? ''
  return path.endsWith('/health') || path.endsWith('/ready')
}

const SENSITIVE_KEYS = [
  'password',
  'newPassword',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'clientSecret',
  'tokenHash',
  'qrSecret',
  // PII under GDPR, and CLAUDE.md forbids logging raw PII outright. No call site in this
  // codebase structured-logs a raw object today (every `this.logger.*` call is a template
  // string; verified across all services) and every flow that touches email already has an
  // id to correlate by (user/operator/invite id), so redacting costs no operability today —
  // it only closes the door on a future `logger.log({ ...dto })` leaking it by accident.
  'email',
] as const

const HEADER_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'req.headers["stripe-signature"]',
]

// `idempotency-key` is deliberately not in the list above: it's a client-generated
// correlation id, not a credential — it grants no access on its own (bearer auth is
// already redacted) and is exactly what support needs to explain a duplicated
// booking/payment, so it stays visible.

// Each key is redacted at the root, under `req.body`, and one level deep anywhere else
// (`*.<key>`). pino-http does not log req.body by default — nothing here relies on it — this
// is defense-in-depth so a future structured log call is safe without remembering to scrub
// it by hand at the call site.
const BODY_REDACT_PATHS = SENSITIVE_KEYS.flatMap((key) => [key, `req.body.${key}`, `*.${key}`])

const REDACT_PATHS = [...HEADER_REDACT_PATHS, ...BODY_REDACT_PATHS]

export function createPinoHttpOptions(nodeEnv: string): Options {
  const isProduction = nodeEnv === 'production'

  return {
    genReqId,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    autoLogging: { ignore: isHealthCheckPath },
    // pino-pretty is a devDependency: only reference it outside production so the worker
    // thread pino spins up for `transport` never requires it in a production build.
    transport: isProduction
      ? undefined
      : { target: 'pino-pretty', options: { singleLine: true, translateTime: 'SYS:standard' } },
  }
}
