import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { PrismaClient } from '@prisma/client'
import type { TestDatabase } from './env'

const API_ROOT = resolve(__dirname, '..', '..')
const DROP_CONFIRM_TIMEOUT_MS = 10_000
const DROP_CONFIRM_POLL_MS = 100

async function withAdminClient<T>(
  database: TestDatabase,
  run: (client: PrismaClient) => Promise<T>,
): Promise<T> {
  const client = new PrismaClient({ datasourceUrl: database.adminUrl })
  try {
    return await run(client)
  } finally {
    await client.$disconnect()
  }
}

/**
 * A previous run killed mid-test leaves its own connections open, and a plain DROP would
 * block on them forever rather than clearing the way for the next run. Signalling
 * termination ourselves first — rather than leaving it entirely to DROP's own FORCE
 * handling — bounds how much of that cleanup happens before the DROP statement itself
 * starts, which keeps it closer to a plain drop of an already-idle database.
 */
async function terminateOtherBackends(client: PrismaClient, name: string): Promise<void> {
  await client.$executeRawUnsafe(
    'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
    name,
  )
}

/**
 * `DROP DATABASE ... WITH (FORCE)` has returned success at least twice here while the
 * name was still resolvable immediately after — the terminated backends' own cleanup
 * apparently isn't guaranteed to be visible by the time the statement completes. Rather
 * than trust that, poll `pg_database` until the name is actually gone before the caller
 * is allowed to CREATE it again. Bounded so a genuinely stuck drop fails loudly instead of
 * hanging the suite.
 */
async function waitUntilDropped(client: PrismaClient, name: string): Promise<void> {
  const deadline = Date.now() + DROP_CONFIRM_TIMEOUT_MS
  for (;;) {
    const [row] = await client.$queryRawUnsafe<Array<{ exists: boolean }>>(
      'SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS "exists"',
      name,
    )
    if (!row?.exists) return
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${DROP_CONFIRM_TIMEOUT_MS}ms waiting for database "${name}" to be dropped`,
      )
    }
    await delay(DROP_CONFIRM_POLL_MS)
  }
}

export async function recreateTestDatabase(database: TestDatabase): Promise<void> {
  await withAdminClient(database, async (client) => {
    await terminateOtherBackends(client, database.name)
    await client.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${database.name}" WITH (FORCE)`)
    await waitUntilDropped(client, database.name)
    await client.$executeRawUnsafe(`CREATE DATABASE "${database.name}"`)
  })
}

export async function dropTestDatabase(database: TestDatabase): Promise<void> {
  await withAdminClient(database, async (client) => {
    await terminateOtherBackends(client, database.name)
    await client.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${database.name}" WITH (FORCE)`)
  })
}

/**
 * Applies the committed migration chain to the empty database. `migrate deploy` (not
 * `db push`) so the run proves the same chain a deployment executes, extensions and
 * generated columns included.
 */
export function applyMigrations(database: TestDatabase): void {
  const cli = require.resolve('prisma/build/index.js', { paths: [API_ROOT] })

  execFileSync(process.execPath, [cli, 'migrate', 'deploy'], {
    cwd: API_ROOT,
    env: { ...process.env, DATABASE_URL: database.url },
    stdio: 'pipe',
  })
}
