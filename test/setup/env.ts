// connection_limit is raised over Prisma's cpu-derived default so the concurrency suite
// exercises real simultaneous transactions instead of queueing on the client pool.
const DEFAULT_DATABASE_URL =
  'postgresql://spark:spark@127.0.0.1:5432/spark_e2e?schema=public&connection_limit=25'

/**
 * The harness DROPs and CREATEs its database on every run, and a database name cannot be
 * a bound parameter in DDL. Both facts make this pattern a safety interlock rather than a
 * style rule: it is what stops a stray DATABASE_URL from pointing the teardown at the
 * developer's own `spark` database.
 *
 * Scoped to `_e2e` only, an orphaned `spark_verify` created by other one-off tooling was
 * once invisible to this same guard and had to be dropped by hand. Widened to a small,
 * explicit set of throwaway suffixes so any script pointing `E2E_DATABASE_URL` at its own
 * scratch database — not just this suite's — gets the same interlock, rather than every
 * one-off tool inventing its own unguarded drop/create. `spark` itself still can never
 * match: every branch requires a `_suffix`, so a bare database name is rejected no matter
 * what suffixes are added here.
 */
const THROWAWAY_DATABASE_NAME = /^[a-z][a-z0-9_]*_(?:e2e|scratch|verify|test|tmp)$/

export const E2E_AUTH_SECRET = 'e2e-auth-secret-0123456789abcdef'

export interface TestDatabase {
  url: string
  /** Connection to the server's `postgres` database, for CREATE/DROP of the test one. */
  adminUrl: string
  name: string
}

export function resolveTestDatabase(): TestDatabase {
  const url = new URL(process.env['E2E_DATABASE_URL'] ?? DEFAULT_DATABASE_URL)
  const name = decodeURIComponent(url.pathname.slice(1))

  if (!THROWAWAY_DATABASE_NAME.test(name)) {
    throw new Error(
      `Refusing to run e2e against database "${name}": the name must match ` +
        `${THROWAWAY_DATABASE_NAME.source}. The harness drops and recreates this database.`,
    )
  }

  const adminUrl = new URL(url.toString())
  adminUrl.pathname = '/postgres'
  adminUrl.search = ''

  return { url: url.toString(), adminUrl: adminUrl.toString(), name }
}

/**
 * Every variable `env.schema.ts` requires, set BEFORE the Nest container boots.
 * @nestjs/config never overwrites an existing process.env entry, so this also guarantees
 * the developer's `apps/api/.env` cannot leak its DATABASE_URL — or its real provider
 * credentials — into a test run. Every value here is a deliberate non-secret placeholder.
 */
export function applyTestEnv(): TestDatabase {
  const database = resolveTestDatabase()

  Object.assign(process.env, {
    NODE_ENV: 'test',
    TZ: 'UTC',
    DATABASE_URL: database.url,
    REDIS_URL: 'redis://127.0.0.1:6379',
    WEB_APP_URL: 'http://localhost:3000',
    AUTH_PROVIDER: 'authjs',
    AUTH_SECRET: E2E_AUTH_SECRET,
    FIREBASE_PROJECT_ID: 'spark-e2e',
    FIREBASE_CLIENT_EMAIL: 'e2e@spark-e2e.invalid',
    FIREBASE_PRIVATE_KEY: 'not-a-real-key',
    FIREBASE_API_KEY: 'not-a-real-key',
    MAP_PROVIDER: 'google',
    GOOGLE_MAPS_API_KEY: 'not-a-real-key',
    PAYMENT_PROVIDER: 'mock',
    MOCK_WEBHOOK_SECRET: 'not-a-real-secret',
    EMAIL_PROVIDER: 'console',
  })

  return database
}
