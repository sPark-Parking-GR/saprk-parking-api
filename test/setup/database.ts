import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { PrismaClient } from '@prisma/client'
import type { TestDatabase } from './env'

const API_ROOT = resolve(__dirname, '..', '..')

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
 * WITH (FORCE) is what makes a run idempotent after a crash: a previous run killed
 * mid-test leaves its own connections open, and a plain DROP would block on them forever
 * rather than clearing the way for the next run.
 */
export async function recreateTestDatabase(database: TestDatabase): Promise<void> {
  await withAdminClient(database, async (client) => {
    await client.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${database.name}" WITH (FORCE)`)
    await client.$executeRawUnsafe(`CREATE DATABASE "${database.name}"`)
  })
}

export async function dropTestDatabase(database: TestDatabase): Promise<void> {
  await withAdminClient(database, async (client) => {
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
