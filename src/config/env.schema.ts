import { z, type RefinementCtx } from 'zod'

const AUTH_PROVIDERS = ['authjs', 'firebase', 'clerk', 'supabase'] as const
const MAP_PROVIDERS = ['google', 'mapbox'] as const
const PAYMENT_PROVIDERS = ['mock', 'stripe'] as const
const EMAIL_PROVIDERS = ['console', 'sendgrid', 'postmark'] as const

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

    // Required regardless of AUTH_PROVIDER: the invite flow always provisions Firebase
    // operator identities via a directly-constructed FirebaseAuthProvider (auth.module.ts).
    FIREBASE_PROJECT_ID: z
      .string()
      .min(1, 'FIREBASE_PROJECT_ID is required (invite flow provisions Firebase identities)'),
    FIREBASE_CLIENT_EMAIL: z
      .string()
      .min(1, 'FIREBASE_CLIENT_EMAIL is required (invite flow provisions Firebase identities)'),
    FIREBASE_PRIVATE_KEY: z
      .string()
      .min(1, 'FIREBASE_PRIVATE_KEY is required (invite flow provisions Firebase identities)'),
    FIREBASE_API_KEY: z
      .string()
      .min(1, 'FIREBASE_API_KEY is required (invite flow provisions Firebase identities)'),

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

    EMAIL_PROVIDER: z.enum(EMAIL_PROVIDERS).default('console'),
    SENDGRID_API_KEY: z.string().optional(),
    EMAIL_FROM_ADDRESS: z.string().optional(),
    EMAIL_FROM_NAME: z.string().optional(),
    POSTMARK_SERVER_TOKEN: z.string().optional(),

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

    requireWhen(ctx, env.EMAIL_PROVIDER === 'sendgrid', 'when EMAIL_PROVIDER=sendgrid', {
      SENDGRID_API_KEY: env.SENDGRID_API_KEY,
      EMAIL_FROM_ADDRESS: env.EMAIL_FROM_ADDRESS,
      EMAIL_FROM_NAME: env.EMAIL_FROM_NAME,
    })
    requireWhen(ctx, env.EMAIL_PROVIDER === 'postmark', 'when EMAIL_PROVIDER=postmark', {
      POSTMARK_SERVER_TOKEN: env.POSTMARK_SERVER_TOKEN,
    })
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
