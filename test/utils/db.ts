import type { PrismaClient } from '@prisma/client'

// PostGIS installs `spatial_ref_sys` into the public schema and it is reference data, not
// application state. `_prisma_migrations` is the record that the chain was applied.
const PRESERVED_TABLES = ['_prisma_migrations', 'spatial_ref_sys']

let cachedTables: string[] | null = null

async function applicationTables(prisma: PrismaClient): Promise<string[]> {
  if (cachedTables) return cachedTables

  const rows = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'`

  cachedTables = rows.map((row) => row.tablename).filter((name) => !PRESERVED_TABLES.includes(name))

  return cachedTables
}

/**
 * Per-test isolation. One TRUNCATE of every application table, CASCADE so foreign keys
 * do not dictate an ordering that would have to be maintained by hand as the schema grows.
 *
 * Truncation rather than a wrapping transaction because the code under test opens its own
 * transactions: `InventoryService.holdSlot` runs its own `$transaction` and the
 * overbooking test needs N of those to be genuinely concurrent. Injecting a shared
 * transaction client through Nest's DI would collapse them onto one connection and quietly
 * turn the very guarantee under test into a no-op.
 */
export async function truncateAll(prisma: PrismaClient): Promise<void> {
  const tables = await applicationTables(prisma)
  if (tables.length === 0) return

  const list = tables.map((name) => `"public"."${name}"`).join(', ')
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`)
  await restoreDefaultPlan(prisma)
}

/**
 * The Starter plan is seeded by migration 20260803100000, so it is part of the schema's
 * post-condition rather than test data — but it lives in an application table and so gets
 * truncated with everything else. Every facility create and restore resolves entitlements
 * against it, so without this each suite would have to remember a seeding line and would
 * otherwise fail with a "no default plan" 503 that looks nothing like its actual cause.
 *
 * Truncating and re-seeding rather than preserving the table: suites create their own
 * plans, and leaving those in place would leak between tests.
 */
async function restoreDefaultPlan(prisma: PrismaClient): Promise<void> {
  await prisma.subscriptionPlan.create({
    data: {
      id: 'plan_starter',
      code: 'starter',
      name: 'Starter',
      priceCents: 0,
      entitlements: {
        maxFacilities: 1,
        maxTariffPlans: null,
        maxStaffSeats: null,
        features: [],
        commissionBps: 0,
      },
    },
  })
}
