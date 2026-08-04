import { Prisma } from '@prisma/client'
import { invalidateFacilityClusterIndex } from '../facilities/facility-cluster-invalidation'

const FACILITY_WRITE_OPERATIONS = new Set([
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
])

/**
 * Bumps the cluster-index write version after every successful Facility mutation, so the
 * public map's in-memory supercluster index (facilities/facility-cluster-index.service.ts)
 * rebuilds on its next read instead of serving a snapshot that predates the write. The bump
 * is debounced by ~1s, so a bulk write burst costs one rebuild rather than thousands.
 *
 * This is a fast path, not the staleness guarantee. The hook fires when the individual
 * statement resolves, which inside an interactive $transaction is before COMMIT, and the
 * counter is per-process — so a build racing the commit gap, or a sibling replica that never
 * saw the write, would stay stale for ever on the version check alone. MAX_INDEX_AGE_MS in
 * the index service is what actually bounds that.
 *
 * WHERE IT APPLIES — the seven top-level write operations on Facility, including inside
 * both $transaction forms, exactly like the lifecycle extension.
 *
 * WHERE IT DOES NOT APPLY:
 * - $queryRaw / $executeRaw / $queryRawUnsafe. No code path writes Facility through raw
 *   SQL: the only raw statements naming the table are the `SELECT ... FOR UPDATE` row
 *   lock in InventoryService, the ingestion dedup SELECT, and the public/admin map's own
 *   count, points and cluster SELECTs. A future raw write would have to invalidate by hand.
 * - Direct database changes (migrations, psql, seeds run outside the app). The index is
 *   per-process and lazily rebuilt, so a replica started afterwards is correct; a running
 *   one would have to be restarted.
 *
 * Invalidation is deliberately AFTER the awaited write: a failed write leaves the index
 * describing the state that still holds, so a rejected update must not force a rebuild.
 */
export const facilityClusterInvalidationExtension = Prisma.defineExtension({
  name: 'facility-cluster-invalidation',
  query: {
    $allOperations({ model, operation, args, query }) {
      if (model !== 'Facility' || !FACILITY_WRITE_OPERATIONS.has(operation)) return query(args)

      return query(args).then((result) => {
        invalidateFacilityClusterIndex()
        return result
      })
    },
  },
})
