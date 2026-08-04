/**
 * Global write-version for the public map's cluster index. Deliberately a bare module
 * counter rather than state on FacilityClusterIndexService: the only writer is a Prisma
 * client extension, which is constructed inside PrismaService itself — reaching a Nest
 * provider from there would make PrismaService depend on a service that depends on
 * PrismaService. Exported standalone for the same reason `withLifecycleFilter` is:
 * the rule is unit-testable without a live client.
 */
let version = 0

/**
 * Trailing-edge debounce window for the bump. Bulk Facility writes are routine here —
 * ingestion promotes and refreshes rows one `facility.update` at a time, and
 * FacilitiesService's bulk paths write many rows per call — while the index is invalidated
 * LAZILY, rebuilt on the next read. Bumping per row therefore does not cost one rebuild per
 * write, it costs one rebuild per READ interleaved with the burst: every search arriving
 * during a multi-minute ingestion job sees a newer version and pays a full table scan plus a
 * synchronous, event-loop-blocking Supercluster.load(). Collapsing a burst into a single
 * bump caps that at one rebuild per second regardless of how many rows the burst writes.
 */
const INVALIDATION_DEBOUNCE_MS = 1_000

let pendingBump: NodeJS.Timeout | null = null

export function invalidateFacilityClusterIndex(): void {
  // A timer already pending will cover this write too, so a burst schedules exactly one.
  if (pendingBump) return

  pendingBump = setTimeout(() => {
    pendingBump = null
    version++
  }, INVALIDATION_DEBOUNCE_MS)

  // The counter only matters to this process's own cache, which dies with it — never hold
  // the event loop open on a pending bump during shutdown.
  pendingBump.unref()
}

export function getFacilityClusterIndexVersion(): number {
  return version
}
