import { z, type RefinementCtx } from 'zod'

const AUTH_PROVIDERS = ['authjs', 'firebase', 'clerk', 'supabase'] as const
const MAP_PROVIDERS = ['google', 'mapbox'] as const
const PAYMENT_PROVIDERS = ['mock', 'stripe'] as const
const SUBSCRIPTION_BILLING_PROVIDERS = ['mock', 'stripe'] as const
// 'postmark' was removed rather than left selectable: its provider threw on every send,
// the postmark package was never a dependency, and it required only a non-empty token to
// pass validation — so it passed production checks more easily than 'console' does while
// guaranteeing a total, partly silent email outage. Re-adding it is a small honest job.
const EMAIL_PROVIDERS = ['console', 'sendgrid'] as const
const PUSH_PROVIDERS = ['console', 'expo'] as const

function requireWhen(
  ctx: RefinementCtx,
  condition: boolean,
  reason: string,
  fields: Record<string, string | undefined>,
): void {
  if (!condition) return
  for (const [key, value] of Object.entries(fields)) {
    if (!value) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${key} is required ${reason}`,
        path: [key],
      })
    }
  }
}

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

    PORT: z.coerce.number().int().positive().default(3001),
    REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
    CORS_ORIGIN: z.string().optional(),
    // 'true' | 'false' | hop count | comma-separated trusted addresses. See parseTrustProxy.
    TRUST_PROXY: z.string().optional(),
    // getOrThrow'd in invite.service.ts to build operator invite accept links
    WEB_APP_URL: z.string().min(1, 'WEB_APP_URL is required (operator invite accept links)'),

    AUTH_PROVIDER: z.enum(AUTH_PROVIDERS).default('authjs'),
    AUTH_SECRET: z.string().optional(),
    CLERK_SECRET_KEY: z.string().optional(),
    CLERK_PUBLISHABLE_KEY: z.string().optional(),
    SUPABASE_URL: z.string().optional(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),

    // Required only when Firebase is the selected provider, like every other strategy's
    // credentials. These were unconditional because the invite flow constructed a Firebase
    // provider directly whatever AUTH_PROVIDER said — so an authjs deployment still could
    // not boot without Google credentials it would never use. Provisioning now goes through
    // the configured provider, and Firebase is one strategy among several again.
    //
    // Still OPTIONAL rather than absent under other providers: a database holding accounts
    // created while Firebase was in use needs the leg present to authenticate them, and
    // CompositeAuthProvider routes those per user on firebaseUid. Supplying them alongside
    // AUTH_PROVIDER=authjs is therefore a legitimate migration state, not a mistake.
    FIREBASE_PROJECT_ID: z.string().optional(),
    FIREBASE_CLIENT_EMAIL: z.string().optional(),
    FIREBASE_PRIVATE_KEY: z.string().optional(),
    FIREBASE_API_KEY: z.string().optional(),

    MAP_PROVIDER: z.enum(MAP_PROVIDERS).default('google'),
    GOOGLE_MAPS_API_KEY: z.string().optional(),
    MAPBOX_ACCESS_TOKEN: z.string().optional(),

    // Pre-release the platform is invite-only; going public is a config change, not a
    // deploy. Defaults to false so an environment that has not decided yet stays closed.
    OPERATOR_SELF_SIGNUP_ENABLED: z.enum(['true', 'false']).default('false'),

    PAYMENT_PROVIDER: z.enum(PAYMENT_PROVIDERS).default('mock'),
    ALLOW_MOCK_PAYMENTS_IN_PRODUCTION: z.enum(['true', 'false']).default('false'),
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
    MOCK_WEBHOOK_SECRET: z.string().optional(),

    // Subscription billing, driver and operator alike. A separate provider selector from
    // PAYMENT_PROVIDER because they are separate engines with separate webhook endpoints and
    // secrets — a deployment can run real one-shot card payments while subscription plans are
    // still mocked, and collapsing them into one switch would make that unexpressible.
    // STRIPE_SECRET_KEY is deliberately shared: it is the same Stripe account either way.
    SUBSCRIPTION_BILLING_PROVIDER: z.enum(SUBSCRIPTION_BILLING_PROVIDERS).default('mock'),
    ALLOW_MOCK_SUBSCRIPTION_BILLING_IN_PRODUCTION: z.enum(['true', 'false']).default('false'),
    ALLOW_CONSOLE_EMAIL_IN_PRODUCTION: z.enum(['true', 'false']).default('false'),
    // One mock secret covers both webhook routes: the mock is driven locally, and there is no
    // second provider account whose deliveries would have to be told apart.
    MOCK_SUBSCRIPTION_WEBHOOK_SECRET: z.string().optional(),
    STRIPE_SUBSCRIPTION_WEBHOOK_SECRET: z.string().optional(),
    // The operator webhook's own signing secret. Stripe issues one PER ENDPOINT, and the
    // driver and operator routes are two endpoints on the one account — sharing a secret
    // would make each accept the other's deliveries, which is precisely the confusion the
    // per-endpoint signature exists to prevent.
    STRIPE_OPERATOR_WEBHOOK_SECRET: z.string().optional(),
    // This API's own absolute base URL, WEB_APP_URL's counterpart for links that point back
    // here. Required only for the mock provider, which is the only thing that builds one:
    // a real Stripe checkout page is hosted by Stripe and needs no address of ours.
    API_PUBLIC_URL: z.string().optional(),

    // Where an operator's manual upgrade request is mailed. Deliberately optional and never
    // required-when: it is a destination for a sales notification, not a security control, and
    // the request it carries is already durable in the audit log before the mail is attempted.
    // Unset, the send is skipped with a logged warning — refusing to boot the whole API over a
    // missing marketing inbox would trade a lost email for a lost deployment.
    PLATFORM_BILLING_CONTACT_EMAIL: z.string().email().optional(),

    EMAIL_PROVIDER: z.enum(EMAIL_PROVIDERS).default('console'),
    SENDGRID_API_KEY: z.string().optional(),
    EMAIL_FROM_ADDRESS: z.string().optional(),
    EMAIL_FROM_NAME: z.string().optional(),

    // Push carries far less sensitive data than email (a booking title, no tokens or
    // credential-bearing links), but the console provider still prints to stdout, so the
    // same explicit-opt-out shape applies for consistency with every other provider guard.
    PUSH_PROVIDER: z.enum(PUSH_PROVIDERS).default('console'),
    ALLOW_CONSOLE_PUSH_IN_PRODUCTION: z.enum(['true', 'false']).default('false'),
    // Optional even under PUSH_PROVIDER=expo: Expo's push API accepts unauthenticated
    // requests by default, unlike every EMAIL_PROVIDER leg.
    EXPO_ACCESS_TOKEN: z.string().optional(),

    // Days a tombstoned resource stays recoverable before the purge worker removes it
    // (anonymises it, for users). See src/lifecycle/lifecycle-purge.service.ts.
    LIFECYCLE_PURGE_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  })
  .passthrough()
  .superRefine((env, ctx) => {
    requireWhen(ctx, env.NODE_ENV === 'production', 'when NODE_ENV=production', {
      CORS_ORIGIN: env.CORS_ORIGIN,
    })

    requireWhen(ctx, env.AUTH_PROVIDER === 'authjs', 'when AUTH_PROVIDER=authjs', {
      AUTH_SECRET: env.AUTH_SECRET,
    })
    requireWhen(ctx, env.AUTH_PROVIDER === 'firebase', 'when AUTH_PROVIDER=firebase', {
      FIREBASE_PROJECT_ID: env.FIREBASE_PROJECT_ID,
      FIREBASE_CLIENT_EMAIL: env.FIREBASE_CLIENT_EMAIL,
      FIREBASE_PRIVATE_KEY: env.FIREBASE_PRIVATE_KEY,
      FIREBASE_API_KEY: env.FIREBASE_API_KEY,
    })
    requireWhen(ctx, env.AUTH_PROVIDER === 'clerk', 'when AUTH_PROVIDER=clerk', {
      CLERK_SECRET_KEY: env.CLERK_SECRET_KEY,
      CLERK_PUBLISHABLE_KEY: env.CLERK_PUBLISHABLE_KEY,
    })
    requireWhen(ctx, env.AUTH_PROVIDER === 'supabase', 'when AUTH_PROVIDER=supabase', {
      SUPABASE_URL: env.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
    })

    requireWhen(ctx, env.MAP_PROVIDER === 'google', 'when MAP_PROVIDER=google', {
      GOOGLE_MAPS_API_KEY: env.GOOGLE_MAPS_API_KEY,
    })
    requireWhen(ctx, env.MAP_PROVIDER === 'mapbox', 'when MAP_PROVIDER=mapbox', {
      MAPBOX_ACCESS_TOKEN: env.MAPBOX_ACCESS_TOKEN,
    })

    requireWhen(ctx, env.PAYMENT_PROVIDER === 'stripe', 'when PAYMENT_PROVIDER=stripe', {
      STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY,
      STRIPE_WEBHOOK_SECRET: env.STRIPE_WEBHOOK_SECRET,
    })

    // The mock provider verifies webhook signatures exactly like the real one and fails
    // closed without a secret, so leaving this unset would reject every delivery rather
    // than quietly accepting forged ones.
    requireWhen(ctx, env.PAYMENT_PROVIDER === 'mock', 'when PAYMENT_PROVIDER=mock', {
      MOCK_WEBHOOK_SECRET: env.MOCK_WEBHOOK_SECRET,
    })

    // The mock provider approves every payment without moving money, so a production
    // deployment silently defaulting to it gives inventory away for free. The opt-out
    // exists only for staging-like environments that run with NODE_ENV=production.
    if (
      env.NODE_ENV === 'production' &&
      env.PAYMENT_PROVIDER === 'mock' &&
      env.ALLOW_MOCK_PAYMENTS_IN_PRODUCTION !== 'true'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'PAYMENT_PROVIDER=mock is refused when NODE_ENV=production. Configure a real provider, or set ALLOW_MOCK_PAYMENTS_IN_PRODUCTION=true to opt out explicitly.',
        path: ['PAYMENT_PROVIDER'],
      })
    }

    requireWhen(
      ctx,
      env.SUBSCRIPTION_BILLING_PROVIDER === 'stripe',
      'when SUBSCRIPTION_BILLING_PROVIDER=stripe',
      {
        STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY,
        STRIPE_SUBSCRIPTION_WEBHOOK_SECRET: env.STRIPE_SUBSCRIPTION_WEBHOOK_SECRET,
        STRIPE_OPERATOR_WEBHOOK_SECRET: env.STRIPE_OPERATOR_WEBHOOK_SECRET,
      },
    )

    // Present is not enough: they must DIFFER. Per the comment on
    // STRIPE_OPERATOR_WEBHOOK_SECRET, the two routes are separate Stripe endpoints and the
    // per-endpoint signature is the only thing that tells their deliveries apart. Pasted
    // identical, each route verifies the other's payloads and the separation silently becomes
    // decoration — a driver-signed body would be accepted by the operator handler, which
    // resolves subscribers and plans from a different catalog entirely.
    if (
      env.SUBSCRIPTION_BILLING_PROVIDER === 'stripe' &&
      env.STRIPE_SUBSCRIPTION_WEBHOOK_SECRET &&
      env.STRIPE_SUBSCRIPTION_WEBHOOK_SECRET === env.STRIPE_OPERATOR_WEBHOOK_SECRET
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'STRIPE_OPERATOR_WEBHOOK_SECRET must differ from STRIPE_SUBSCRIPTION_WEBHOOK_SECRET. Stripe issues one signing secret per endpoint, and the driver and operator webhooks are two endpoints: sharing a secret makes each accept the other endpoint’s deliveries, which is exactly what the per-endpoint signature exists to prevent.',
        path: ['STRIPE_OPERATOR_WEBHOOK_SECRET'],
      })
    }

    // Same reasoning as MOCK_WEBHOOK_SECRET: the mock subscription provider verifies
    // signatures exactly like Stripe and fails closed without a secret, so an unset value
    // rejects every delivery rather than quietly accepting forged ones. API_PUBLIC_URL joins
    // it because the mock checkout URL handed to the client is built from it — unset, every
    // rider is sent to a link that resolves nowhere.
    requireWhen(
      ctx,
      env.SUBSCRIPTION_BILLING_PROVIDER === 'mock',
      'when SUBSCRIPTION_BILLING_PROVIDER=mock',
      {
        MOCK_SUBSCRIPTION_WEBHOOK_SECRET: env.MOCK_SUBSCRIPTION_WEBHOOK_SECRET,
        API_PUBLIC_URL: env.API_PUBLIC_URL,
      },
    )

    // The mock subscription provider grants a paid plan's perks without taking a cent, so a
    // production deployment defaulting to it gives discounts away. Same explicit opt-out as
    // ALLOW_MOCK_PAYMENTS_IN_PRODUCTION, and separate from it: the two engines are configured
    // independently, so one opt-out must never imply the other.
    if (
      env.NODE_ENV === 'production' &&
      env.SUBSCRIPTION_BILLING_PROVIDER === 'mock' &&
      env.ALLOW_MOCK_SUBSCRIPTION_BILLING_IN_PRODUCTION !== 'true'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'SUBSCRIPTION_BILLING_PROVIDER=mock is refused when NODE_ENV=production. Configure a real provider, or set ALLOW_MOCK_SUBSCRIPTION_BILLING_IN_PRODUCTION=true to opt out explicitly.',
        path: ['SUBSCRIPTION_BILLING_PROVIDER'],
      })
    }

    // The console provider does not send mail — it prints the message, invite accept URLs
    // and their live tokens included, straight to stdout. In production that is both an
    // outage nobody is told about (every invite reports delivered while no one receives
    // one) and credential-bearing links in the log pipeline. Same explicit opt-out shape as
    // the mock payment and billing guards above, so a deployment that genuinely wants it
    // has to say so.
    if (
      env.NODE_ENV === 'production' &&
      env.EMAIL_PROVIDER === 'console' &&
      env.ALLOW_CONSOLE_EMAIL_IN_PRODUCTION !== 'true'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'EMAIL_PROVIDER=console is refused when NODE_ENV=production: it prints invite links and their tokens to stdout instead of sending them. Configure a real provider, or set ALLOW_CONSOLE_EMAIL_IN_PRODUCTION=true to opt out explicitly.',
        path: ['EMAIL_PROVIDER'],
      })
    }

    requireWhen(ctx, env.EMAIL_PROVIDER === 'sendgrid', 'when EMAIL_PROVIDER=sendgrid', {
      SENDGRID_API_KEY: env.SENDGRID_API_KEY,
      EMAIL_FROM_ADDRESS: env.EMAIL_FROM_ADDRESS,
      EMAIL_FROM_NAME: env.EMAIL_FROM_NAME,
    })

    if (
      env.NODE_ENV === 'production' &&
      env.PUSH_PROVIDER === 'console' &&
      env.ALLOW_CONSOLE_PUSH_IN_PRODUCTION !== 'true'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'PUSH_PROVIDER=console is refused when NODE_ENV=production: every push notification prints to stdout instead of being sent, a silent outage nobody is told about. Configure a real provider, or set ALLOW_CONSOLE_PUSH_IN_PRODUCTION=true to opt out explicitly.',
        path: ['PUSH_PROVIDER'],
      })
    }
  })

export type EnvConfig = z.infer<typeof envSchema>

export function validateEnv(config: Record<string, unknown>): EnvConfig {
  const result = envSchema.safeParse(config)

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n')
    throw new Error(`Invalid environment configuration:\n${issues}`)
  }

  return result.data
}

// NODE_ENV=production requires CORS_ORIGIN (enforced above), so an empty value here only
// reaches enableCors() in local/test environments, where permissive CORS is intentional.
/**
 * Fastify only derives the client address from `X-Forwarded-For` when told which proxies
 * to trust. Left unset, `request.ip` behind a load balancer is the balancer's own address
 * — which silently collapses every caller into one rate-limit bucket (ThrottlerGuard keys
 * on it) and writes the wrong IP to the audit log.
 *
 * Defaults to false rather than true: trusting every hop lets anyone who can reach this
 * service forge the header and evade per-IP throttling. Deployers set the hop count, or a
 * trusted-address list, to match their actual topology.
 */
export function parseTrustProxy(raw: string | undefined): boolean | number | string {
  if (!raw) return false
  const value = raw.trim()
  if (value === 'true') return true
  if (value === 'false') return false
  const hops = Number(value)
  return Number.isInteger(hops) && hops > 0 ? hops : value
}

export function parseCorsOrigin(raw: string | undefined): string[] | true {
  if (!raw) return true
  const origins = raw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
  return origins.length > 0 ? origins : true
}
