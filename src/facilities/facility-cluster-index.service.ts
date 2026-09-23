import { Injectable, Logger } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import Supercluster from 'supercluster'
import { PrismaService } from '../prisma/prisma.service'
import { getFacilityClusterIndexVersion } from './facility-cluster-invalidation'
import type { FacilityCluster, MapBounds } from './facilities.types'

// Declared as type aliases, not interfaces: supercluster constrains both parameters to
// GeoJsonProperties (an index signature), which only an alias satisfies implicitly.
type FacilityPointProps = { facilityId: string }
type ClusterAggProps = Record<string, unknown>

/**
 * `clusters` holds only groups that met CLUSTER_MIN_POINTS; everything below
 * that comes back as a facility id in `singletonIds` instead, for the caller
 * to hydrate into a real point marker rather than a same-as-a-cluster bubble
 * of 1-4.
 */
export interface ClusterQueryResult {
  clusters: FacilityCluster[]
  singletonIds: string[]
}

interface CachedIndex {
  index: Supercluster<FacilityPointProps, ClusterAggProps>
  version: number
  builtAt: number
}

interface FacilityPointRow {
  id: string
  lat: number
  lng: number
}

const CLUSTER_RADIUS_PX = 60
const CLUSTER_MAX_ZOOM = 16
// Below this many facilities, a group renders as its own individual markers
// instead of a cluster bubble — a bubble reading "3" is more friction than
// three real pins a user can immediately tell apart and tap.
const CLUSTER_MIN_POINTS = 5

/**
 * Hard staleness ceiling, applied on top of — not instead of — the version check. The
 * counter alone cannot bound staleness, for two independent reasons:
 *
 * - It is bumped when the individual Prisma statement resolves, but every Facility write
 *   here runs inside an interactive `$transaction` that does more work (audit log, ownership
 *   period, rules) before COMMIT. A build that reads the counter in that gap queries a
 *   separate pooled connection that cannot see the uncommitted row, then stamps the result
 *   with the very version the write produced — so the entry matches for ever after and the
 *   write is never reflected until some unrelated write bumps the counter again.
 * - It is a per-process module global, so a write served by one replica leaves every other
 *   replica's cache looking current indefinitely.
 *
 * Rebuilding anything older than a minute regardless of version puts a fixed floor under
 * both. Creating or deactivating a facility is not a real-time-critical operation, so a
 * bounded staleness window is the cheap, standard trade against hooking Prisma's actual
 * post-commit moment or introducing cross-replica pub/sub.
 */
const MAX_INDEX_AGE_MS = 60_000

/**
 * Backstop, not an expected-to-bind limit: it exists so the index's memory and load() cost
 * cannot grow without bound with total published facility count. Far above any realistic
 * near-term national dataset; rows past it are dropped from that key's index.
 */
const MAX_INDEX_POINTS = 200_000

/**
 * Web-Mercator zoom whose viewport spans the given longitude width. Derived here rather
 * than taken as a request parameter so the mobile client keeps sending exactly the bounds
 * it already sends: zoom and longitude width are the same quantity expressed twice, and a
 * client-supplied zoom that disagreed with the bounds would cluster at the wrong scale.
 */
export function zoomFromBounds(bounds: MapBounds): number {
  const width = Math.max(bounds.east - bounds.west, 1e-6)
  return Math.min(Math.max(Math.round(Math.log2(360 / width)), 0), CLUSTER_MAX_ZOOM)
}

function isCluster(
  feature:
    Supercluster.ClusterFeature<ClusterAggProps> | Supercluster.PointFeature<FacilityPointProps>,
): feature is Supercluster.ClusterFeature<ClusterAggProps> {
  return 'cluster' in feature.properties
}

function toCluster(feature: Supercluster.ClusterFeature<ClusterAggProps>): FacilityCluster {
  return {
    id: `c_${feature.properties.cluster_id}`,
    lat: feature.geometry.coordinates[1]!,
    lng: feature.geometry.coordinates[0]!,
    count: feature.properties.point_count,
  }
}

/**
 * The public map's cluster source: one in-memory supercluster index per vehicle-type
 * filter, queried per request at the zoom the viewport implies.
 *
 * It replaces the fixed 12x12 SQL grid for the public search path (the admin map keeps
 * that grid — its filter set is too variable to precompute). The grid re-bucketed on every
 * request, so clusters jumped as the viewport moved; a supercluster hierarchy is built
 * once over the WHOLE visible dataset and merely queried per viewport, which is also why
 * the index is built from the visibility predicate alone, with no bounds term.
 *
 * Cache invalidation is a lazy per-process rebuild on the next read, triggered by whichever
 * comes first: a bump of the per-process write version (debounced, see
 * prisma/facility-cluster-invalidation.extension.ts) or MAX_INDEX_AGE_MS since the entry was
 * built. The version is the fast path, not the guarantee — it is bumped before the enclosing
 * transaction commits and is invisible to other replicas, so what actually bounds staleness
 * is the TTL: any Facility write is reflected on every replica within MAX_INDEX_AGE_MS, and
 * usually within the debounce window. No Redis, no cross-replica coordination.
 */
@Injectable()
export class FacilityClusterIndexService {
  private readonly logger = new Logger(FacilityClusterIndexService.name)
  private readonly cache = new Map<string, CachedIndex>()
  private readonly building = new Map<
    string,
    Promise<Supercluster<FacilityPointProps, ClusterAggProps>>
  >()

  constructor(private readonly prisma: PrismaService) {}

  async getClusters(
    cacheKey: string,
    whereSql: Prisma.Sql,
    bounds: MapBounds,
  ): Promise<ClusterQueryResult> {
    const index = await this.indexFor(cacheKey, whereSql)
    const bbox: [number, number, number, number] = [
      bounds.west,
      bounds.south,
      bounds.east,
      bounds.north,
    ]

    const features = index.getClusters(bbox, zoomFromBounds(bounds))
    const clusters: FacilityCluster[] = []
    const singletonIds: string[] = []
    for (const feature of features) {
      if (isCluster(feature)) {
        clusters.push(toCluster(feature))
      } else {
        singletonIds.push(feature.properties.facilityId)
      }
    }
    return { clusters, singletonIds }
  }

  /**
   * Concurrent misses on the same key share ONE build. Without this, the first request
   * after a write would be joined by every other in-flight request in the same tick, each
   * issuing its own full-table scan — the rebuild is exactly when the cache is least able
   * to absorb load. The in-flight entry is cleared on settle, including on failure, so a
   * failed build is retried rather than remembered forever.
   */
  private async indexFor(
    cacheKey: string,
    whereSql: Prisma.Sql,
  ): Promise<Supercluster<FacilityPointProps, ClusterAggProps>> {
    const version = getFacilityClusterIndexVersion()
    const builtAt = Date.now()
    const cached = this.cache.get(cacheKey)
    if (cached && cached.version === version && builtAt - cached.builtAt <= MAX_INDEX_AGE_MS) {
      return cached.index
    }

    const inFlight = this.building.get(cacheKey)
    if (inFlight) return inFlight

    const build = this.build(whereSql)
      .then((index) => {
        // Stamped with the version and clock read BEFORE the query: a write that landed
        // mid-build may be missing from these rows, so the entry must already look stale,
        // and its age must cover the query it was built from rather than start at settle.
        this.cache.set(cacheKey, { index, version, builtAt })
        return index
      })
      .finally(() => {
        this.building.delete(cacheKey)
      })

    this.building.set(cacheKey, build)
    return build
  }

  private async build(
    whereSql: Prisma.Sql,
  ): Promise<Supercluster<FacilityPointProps, ClusterAggProps>> {
    const rows = await this.prisma.$queryRaw<FacilityPointRow[]>`
      SELECT id, ST_Y("geog"::geometry) AS lat, ST_X("geog"::geometry) AS lng
      FROM "Facility"
      WHERE ${whereSql}
      LIMIT ${MAX_INDEX_POINTS}`

    if (rows.length >= MAX_INDEX_POINTS) {
      this.logger.warn(
        `Facility cluster index hit the ${MAX_INDEX_POINTS}-point cap; facilities beyond it are not mapped`,
      )
    }

    const points = rows.map((row): Supercluster.PointFeature<FacilityPointProps> => ({
      type: 'Feature',
      properties: { facilityId: row.id },
      geometry: { type: 'Point', coordinates: [Number(row.lng), Number(row.lat)] },
    }))

    this.logger.log(`Rebuilt facility cluster index from ${points.length} facilities`)

    return new Supercluster<FacilityPointProps, ClusterAggProps>({
      radius: CLUSTER_RADIUS_PX,
      maxZoom: CLUSTER_MAX_ZOOM,
      minPoints: CLUSTER_MIN_POINTS,
    }).load(points)
  }
}
