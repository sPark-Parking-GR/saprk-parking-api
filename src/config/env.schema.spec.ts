import { parseCorsOrigin, parseTrustProxy, validateEnv } from './env.schema'

const REQUIRED_BASE = {
  DATABASE_URL: 'postgresql://spark:spark@localhost:5432/spark',
  WEB_APP_URL: 'http://localhost:3000',
  FIREBASE_PROJECT_ID: 'proj',
  FIREBASE_CLIENT_EMAIL: 'svc@proj.iam.gserviceaccount.com',
  FIREBASE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----',
  FIREBASE_API_KEY: 'firebase-api-key',
  AUTH_PROVIDER: 'authjs',
  AUTH_SECRET: 'a'.repeat(32),
  GOOGLE_MAPS_API_KEY: 'maps-key',
  // PAYMENT_PROVIDER defaults to mock, and the mock verifies webhook signatures too.
  MOCK_WEBHOOK_SECRET: 'mock-webhook-secret',
  // SUBSCRIPTION_BILLING_PROVIDER defaults to mock for the same reason, and its mock also
  // builds the checkout link it hands the client out of API_PUBLIC_URL.
  MOCK_SUBSCRIPTION_WEBHOOK_SECRET: 'mock-subscription-secret',
  API_PUBLIC_URL: 'http://localhost:3001',
}

/** Both mock engines swapped for real ones, so the production guards have nothing to catch. */
const REAL_PROVIDERS = {
  PAYMENT_PROVIDER: 'stripe',
  SUBSCRIPTION_BILLING_PROVIDER: 'stripe',
  STRIPE_SECRET_KEY: 'sk_live',
  STRIPE_WEBHOOK_SECRET: 'whsec',
  STRIPE_SUBSCRIPTION_WEBHOOK_SECRET: 'whsec_sub',
  STRIPE_OPERATOR_WEBHOOK_SECRET: 'whsec_op',
}

describe('validateEnv', () => {
  it('accepts the minimal required set and applies documented defaults', () => {
    const result = validateEnv({ ...REQUIRED_BASE })

    expect(result.PORT).toBe(3001)
    expect(result.REDIS_URL).toBe('redis://localhost:6379')
    expect(result.MAP_PROVIDER).toBe('google')
    expect(result.PAYMENT_PROVIDER).toBe('mock')
    expect(result.EMAIL_PROVIDER).toBe('console')
  })

  it('passes through env vars it does not model, unchanged', () => {
    const result = validateEnv({ ...REQUIRED_BASE, OVERPASS_URL: 'https://example.test' })

    expect((result as Record<string, unknown>)['OVERPASS_URL']).toBe('https://example.test')
  })

  it('throws one aggregated error naming every missing var', () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_URL/)
    expect(() => validateEnv({})).toThrow(/WEB_APP_URL/)
    expect(() => validateEnv({})).toThrow(/FIREBASE_PROJECT_ID/)
  })

  it('requires AUTH_SECRET only when AUTH_PROVIDER=authjs', () => {
    expect(() => validateEnv({ ...REQUIRED_BASE, AUTH_SECRET: undefined })).toThrow(/AUTH_SECRET/)
  })

  it('requires CLERK vars when AUTH_PROVIDER=clerk, and not AUTH_SECRET', () => {
    expect(() =>
      validateEnv({ ...REQUIRED_BASE, AUTH_PROVIDER: 'clerk', AUTH_SECRET: undefined }),
    ).toThrow(/CLERK_SECRET_KEY/)

    const result = validateEnv({
      ...REQUIRED_BASE,
      AUTH_PROVIDER: 'clerk',
      AUTH_SECRET: undefined,
      CLERK_SECRET_KEY: 'sk_test',
      CLERK_PUBLISHABLE_KEY: 'pk_test',
    })
    expect(result.AUTH_PROVIDER).toBe('clerk')
  })

  it('requires FIREBASE_* even when AUTH_PROVIDER is not firebase', () => {
    expect(() => validateEnv({ ...REQUIRED_BASE, FIREBASE_PROJECT_ID: undefined })).toThrow(
      /FIREBASE_PROJECT_ID/,
    )
  })

  it('requires STRIPE vars only when PAYMENT_PROVIDER=stripe', () => {
    expect(() => validateEnv({ ...REQUIRED_BASE, PAYMENT_PROVIDER: 'stripe' })).toThrow(
      /STRIPE_SECRET_KEY/,
    )
    expect(() => validateEnv({ ...REQUIRED_BASE, PAYMENT_PROVIDER: 'mock' })).not.toThrow()
  })

  it('requires MOCK_WEBHOOK_SECRET only when PAYMENT_PROVIDER=mock', () => {
    expect(() => validateEnv({ ...REQUIRED_BASE, MOCK_WEBHOOK_SECRET: undefined })).toThrow(
      /MOCK_WEBHOOK_SECRET/,
    )
    expect(() =>
      validateEnv({
        ...REQUIRED_BASE,
        MOCK_WEBHOOK_SECRET: undefined,
        PAYMENT_PROVIDER: 'stripe',
        STRIPE_SECRET_KEY: 'sk_test',
        STRIPE_WEBHOOK_SECRET: 'whsec_test',
      }),
    ).not.toThrow()
  })

  it('requires SENDGRID vars only when EMAIL_PROVIDER=sendgrid', () => {
    expect(() => validateEnv({ ...REQUIRED_BASE, EMAIL_PROVIDER: 'sendgrid' })).toThrow(
      /SENDGRID_API_KEY/,
    )
  })

  it('defaults NODE_ENV to development and allows CORS_ORIGIN to stay unset', () => {
    const result = validateEnv({ ...REQUIRED_BASE })
    expect(result.NODE_ENV).toBe('development')
  })

  it('does not require CORS_ORIGIN outside production', () => {
    expect(() =>
      validateEnv({ ...REQUIRED_BASE, NODE_ENV: 'test', CORS_ORIGIN: undefined }),
    ).not.toThrow()
  })

  it('refuses PAYMENT_PROVIDER=mock when NODE_ENV=production', () => {
    expect(() =>
      validateEnv({
        ...REQUIRED_BASE,
        NODE_ENV: 'production',
        CORS_ORIGIN: 'https://app.spark.com',
        PAYMENT_PROVIDER: 'mock',
      }),
    ).toThrow(/PAYMENT_PROVIDER=mock is refused/)
  })

  it('allows mock in production only with the explicit opt-out', () => {
    const result = validateEnv({
      ...REQUIRED_BASE,
      NODE_ENV: 'production',
      CORS_ORIGIN: 'https://app.spark.com',
      PAYMENT_PROVIDER: 'mock',
      ALLOW_MOCK_PAYMENTS_IN_PRODUCTION: 'true',
      SUBSCRIPTION_BILLING_PROVIDER: 'stripe',
      STRIPE_SECRET_KEY: 'sk_live',
      STRIPE_SUBSCRIPTION_WEBHOOK_SECRET: 'whsec_sub',
      STRIPE_OPERATOR_WEBHOOK_SECRET: 'whsec_op',
    })
    expect(result.PAYMENT_PROVIDER).toBe('mock')
  })

  it('leaves a real provider in production untouched by the mock guard', () => {
    const result = validateEnv({
      ...REQUIRED_BASE,
      NODE_ENV: 'production',
      CORS_ORIGIN: 'https://app.spark.com',
      ...REAL_PROVIDERS,
    })
    expect(result.PAYMENT_PROVIDER).toBe('stripe')
  })

  it('does not restrict mock outside production', () => {
    expect(() => validateEnv({ ...REQUIRED_BASE, PAYMENT_PROVIDER: 'mock' })).not.toThrow()
  })

  it('requires CORS_ORIGIN when NODE_ENV=production', () => {
    expect(() =>
      validateEnv({ ...REQUIRED_BASE, NODE_ENV: 'production', CORS_ORIGIN: undefined }),
    ).toThrow(/CORS_ORIGIN/)

    const result = validateEnv({
      ...REQUIRED_BASE,
      NODE_ENV: 'production',
      CORS_ORIGIN: 'https://app.spark.com',
      ...REAL_PROVIDERS,
    })
    expect(result.CORS_ORIGIN).toBe('https://app.spark.com')
  })

  it('defaults SUBSCRIPTION_BILLING_PROVIDER to mock, independently of PAYMENT_PROVIDER', () => {
    const result = validateEnv({ ...REQUIRED_BASE })

    expect(result.SUBSCRIPTION_BILLING_PROVIDER).toBe('mock')
    expect(result.ALLOW_MOCK_SUBSCRIPTION_BILLING_IN_PRODUCTION).toBe('false')
  })

  it('requires the mock subscription secret and API_PUBLIC_URL only for the mock provider', () => {
    expect(() =>
      validateEnv({ ...REQUIRED_BASE, MOCK_SUBSCRIPTION_WEBHOOK_SECRET: undefined }),
    ).toThrow(/MOCK_SUBSCRIPTION_WEBHOOK_SECRET/)
    expect(() => validateEnv({ ...REQUIRED_BASE, API_PUBLIC_URL: undefined })).toThrow(
      /API_PUBLIC_URL/,
    )

    expect(() =>
      validateEnv({
        ...REQUIRED_BASE,
        MOCK_SUBSCRIPTION_WEBHOOK_SECRET: undefined,
        API_PUBLIC_URL: undefined,
        SUBSCRIPTION_BILLING_PROVIDER: 'stripe',
        STRIPE_SECRET_KEY: 'sk_test',
        STRIPE_SUBSCRIPTION_WEBHOOK_SECRET: 'whsec_sub',
        STRIPE_OPERATOR_WEBHOOK_SECRET: 'whsec_op',
      }),
    ).not.toThrow()
  })

  // A second endpoint signing secret, not a reuse of STRIPE_WEBHOOK_SECRET: Stripe issues
  // one per endpoint and the subscription endpoint is a different endpoint.
  it('requires its own Stripe webhook secret when SUBSCRIPTION_BILLING_PROVIDER=stripe', () => {
    expect(() =>
      validateEnv({
        ...REQUIRED_BASE,
        SUBSCRIPTION_BILLING_PROVIDER: 'stripe',
        STRIPE_SECRET_KEY: 'sk_test',
      }),
    ).toThrow(/STRIPE_SUBSCRIPTION_WEBHOOK_SECRET/)
  })

  // A THIRD, for the same reason: /operator-subscriptions/webhook is its own Stripe endpoint,
  // and sharing the driver endpoint's secret would make each accept the other's deliveries.
  it('requires the operator webhook secret when SUBSCRIPTION_BILLING_PROVIDER=stripe', () => {
    expect(() =>
      validateEnv({
        ...REQUIRED_BASE,
        SUBSCRIPTION_BILLING_PROVIDER: 'stripe',
        STRIPE_SECRET_KEY: 'sk_test',
        STRIPE_SUBSCRIPTION_WEBHOOK_SECRET: 'whsec_sub',
      }),
    ).toThrow(/STRIPE_OPERATOR_WEBHOOK_SECRET/)
  })

  /**
   * Present is not enough. Two endpoints, two signing secrets — pasted identical, each route
   * verifies the other's payloads and the per-endpoint signature stops separating anything.
   */
  it('refuses the two Stripe webhook secrets when they are the same value', () => {
    expect(() =>
      validateEnv({
        ...REQUIRED_BASE,
        SUBSCRIPTION_BILLING_PROVIDER: 'stripe',
        STRIPE_SECRET_KEY: 'sk_test',
        STRIPE_SUBSCRIPTION_WEBHOOK_SECRET: 'whsec_same',
        STRIPE_OPERATOR_WEBHOOK_SECRET: 'whsec_same',
      }),
    ).toThrow(/STRIPE_OPERATOR_WEBHOOK_SECRET must differ/)
  })

  it('accepts the two Stripe webhook secrets when they are distinct', () => {
    expect(() =>
      validateEnv({
        ...REQUIRED_BASE,
        SUBSCRIPTION_BILLING_PROVIDER: 'stripe',
        STRIPE_SECRET_KEY: 'sk_test',
        STRIPE_SUBSCRIPTION_WEBHOOK_SECRET: 'whsec_driver',
        STRIPE_OPERATOR_WEBHOOK_SECRET: 'whsec_operator',
      }),
    ).not.toThrow()
  })

  // The mock provider has one secret for both routes by design, so the inequality rule must
  // not fire when the Stripe secrets are simply both unset.
  it('does not apply the inequality rule to the mock provider', () => {
    expect(() =>
      validateEnv({
        ...REQUIRED_BASE,
        STRIPE_SUBSCRIPTION_WEBHOOK_SECRET: undefined,
        STRIPE_OPERATOR_WEBHOOK_SECRET: undefined,
      }),
    ).not.toThrow()
  })

  // The mock is driven locally and has no per-endpoint registration to mirror, so the one
  // mock secret covers both routes and neither Stripe secret is consulted.
  it('does not require the operator webhook secret for the mock provider', () => {
    expect(() =>
      validateEnv({ ...REQUIRED_BASE, STRIPE_OPERATOR_WEBHOOK_SECRET: undefined }),
    ).not.toThrow()
  })

  it('refuses SUBSCRIPTION_BILLING_PROVIDER=mock in production without its own opt-out', () => {
    const productionMockBilling = {
      ...REQUIRED_BASE,
      NODE_ENV: 'production',
      CORS_ORIGIN: 'https://app.spark.com',
      PAYMENT_PROVIDER: 'stripe',
      STRIPE_SECRET_KEY: 'sk_live',
      STRIPE_WEBHOOK_SECRET: 'whsec',
      SUBSCRIPTION_BILLING_PROVIDER: 'mock',
    }

    expect(() => validateEnv(productionMockBilling)).toThrow(
      /SUBSCRIPTION_BILLING_PROVIDER=mock is refused/,
    )
    // The payments opt-out must NOT carry over: the two engines are configured
    // independently, and one waiver implying the other is how free perks ship to production.
    expect(() =>
      validateEnv({ ...productionMockBilling, ALLOW_MOCK_PAYMENTS_IN_PRODUCTION: 'true' }),
    ).toThrow(/SUBSCRIPTION_BILLING_PROVIDER=mock is refused/)

    const result = validateEnv({
      ...productionMockBilling,
      ALLOW_MOCK_SUBSCRIPTION_BILLING_IN_PRODUCTION: 'true',
    })
    expect(result.SUBSCRIPTION_BILLING_PROVIDER).toBe('mock')
  })
})

describe('parseTrustProxy', () => {
  it('defaults to false so X-Forwarded-For is never trusted implicitly', () => {
    expect(parseTrustProxy(undefined)).toBe(false)
    expect(parseTrustProxy('')).toBe(false)
    expect(parseTrustProxy('false')).toBe(false)
  })

  it('accepts an explicit boolean', () => {
    expect(parseTrustProxy('true')).toBe(true)
  })

  it('accepts a hop count as a number', () => {
    expect(parseTrustProxy('1')).toBe(1)
    expect(parseTrustProxy(' 2 ')).toBe(2)
  })

  it('passes a trusted-address list through as a string for fastify to parse', () => {
    expect(parseTrustProxy('10.0.0.1,192.168.0.0/16')).toBe('10.0.0.1,192.168.0.0/16')
  })

  it('does not treat zero or a negative hop count as a hop count', () => {
    expect(parseTrustProxy('0')).toBe('0')
    expect(parseTrustProxy('-1')).toBe('-1')
  })
})

describe('parseCorsOrigin', () => {
  it('returns true (permissive) when unset or empty', () => {
    expect(parseCorsOrigin(undefined)).toBe(true)
    expect(parseCorsOrigin('')).toBe(true)
    expect(parseCorsOrigin('   ')).toBe(true)
  })

  it('splits comma-separated origins and trims whitespace', () => {
    expect(parseCorsOrigin('https://a.com, https://b.com')).toEqual([
      'https://a.com',
      'https://b.com',
    ])
  })

  it('returns a single-element array for one origin', () => {
    expect(parseCorsOrigin('https://app.spark.com')).toEqual(['https://app.spark.com'])
  })

  it('drops empty entries from trailing/duplicate commas', () => {
    expect(parseCorsOrigin('https://a.com,,https://b.com,')).toEqual([
      'https://a.com',
      'https://b.com',
    ])
  })
})
