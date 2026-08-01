import { LifecycleStatus, Prisma } from '@prisma/client'

export const LIFECYCLE_MODELS = ['User', 'ParkingOperator', 'Facility', 'TariffPlan'] as const

export type LifecycleModel = (typeof LIFECYCLE_MODELS)[number]

export const ALL_LIFECYCLE_STATUSES = [
  LifecycleStatus.ACTIVE,
  LifecycleStatus.ARCHIVED,
  LifecycleStatus.TOMBSTONED,
  LifecycleStatus.PURGED,
] as const

/**
 * Opt-out marker for call sites that must see rows in every lifecycle state (admin
 * views, the lifecycle service itself, pinned pricing). Any query whose top-level
 * `where` mentions `lifecycleStatus` — directly or in a top-level AND — is left alone
 * by the extension.
 */
export function anyLifecycleStatus(): { in: LifecycleStatus[] } {
  return { in: [...ALL_LIFECYCLE_STATUSES] }
}

const UNIQUE_WHERE_OPERATIONS = new Set(['findUnique', 'findUniqueOrThrow', 'update', 'delete'])

const FILTERED_OPERATIONS = new Set([
  ...UNIQUE_WHERE_OPERATIONS,
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'count',
  'aggregate',
  'groupBy',
  'updateMany',
  'deleteMany',
])

type WhereClause = Record<string, unknown>

interface ArgsWithWhere {
  where?: WhereClause
}

function mentionsLifecycleStatus(where: WhereClause | undefined): boolean {
  if (!where) return false
  if ('lifecycleStatus' in where) return true
  const and = where['AND']
  const clauses = Array.isArray(and) ? and : and !== undefined ? [and] : []
  return clauses.some(
    (clause) =>
      typeof clause === 'object' && clause !== null && 'lifecycleStatus' in (clause as WhereClause),
  )
}

/**
 * Injects `lifecycleStatus: ACTIVE` into the query's `where` unless the caller already
 * expressed a lifecycle intent. Exported separately from the extension so the rewrite
 * rules are unit-testable without a live client.
 */
export function withLifecycleFilter(model: string, operation: string, args: unknown): unknown {
  if (!(LIFECYCLE_MODELS as readonly string[]).includes(model)) return args
  if (!FILTERED_OPERATIONS.has(operation)) return args

  const current = (args ?? {}) as ArgsWithWhere
  if (mentionsLifecycleStatus(current.where)) return args

  if (UNIQUE_WHERE_OPERATIONS.has(operation)) {
    return { ...current, where: { ...current.where, lifecycleStatus: LifecycleStatus.ACTIVE } }
  }

  return {
    ...current,
    where: current.where
      ? { AND: [current.where, { lifecycleStatus: LifecycleStatus.ACTIVE }] }
      : { lifecycleStatus: LifecycleStatus.ACTIVE },
  }
}

/**
 * Default-hides non-ACTIVE lifecycle rows from every Prisma query so the ~40 existing
 * call sites need no per-site audit. COVERAGE IS NOT TOTAL, and every gap below is
 * handled explicitly rather than assumed away:
 *
 * WHERE THE EXTENSION APPLIES — top-level operations on the four lifecycle models:
 * findMany / findFirst(-OrThrow) / findUnique(-OrThrow) / count / aggregate / groupBy /
 * update(-Many) / delete(-Many), including inside both $transaction forms. findUnique is
 * intercepted and accepts the added non-unique filter (extended where-unique is GA in
 * this Prisma version); the e2e suite asserts this rather than trusting it.
 *
 * WHERE IT DOES NOT APPLY:
 * - $queryRaw / $executeRaw / $queryRawUnsafe. Handled per site: the public facility
 *   search predicate (PUBLIC_VISIBLE_SQL) and the admin-map SQL carry an explicit
 *   lifecycle term; SELECT ... FOR UPDATE row locks are id-only and safe; analytics
 *   deliberately IGNORES lifecycle (revenue attribution is financial history and must
 *   not vanish when a facility is archived — and purge is FK-blocked for any row with
 *   payments, so analytics can never dangle); the ingestion dedup query deliberately
 *   matches archived facilities so a re-import cannot resurrect a duplicate.
 * - Nested relation reads (include/select through a relation). A booking's archived
 *   facility or user still renders — correct for historical records. Where it would
 *   leak, the call site guards in memory: isPlanApplicable() rejects non-ACTIVE plans
 *   loaded through FacilityTariffAssignment includes, and the public facility detail
 *   nulls out non-ACTIVE assigned plans.
 * - Relation filters inside `where` traverse related rows unfiltered; no current call
 *   site returns rows OF a lifecycle model through one.
 * - upsert and nested writes (connect/create). The only upsert on a lifecycle model is
 *   ingestion's fixed-id synthetic unclaimed operator.
 */
export const lifecycleExtension = Prisma.defineExtension({
  name: 'lifecycle-default-filter',
  query: {
    $allOperations({ model, operation, args, query }) {
      if (!model) return query(args)
      return query(withLifecycleFilter(model, operation, args) as typeof args)
    },
  },
})
