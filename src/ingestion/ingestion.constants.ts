export const INGESTION_QUEUE = 'ingestion'

// Promotion runs on its own queue so its worker never competes with the
// rate-limited Overpass fetch worker for jobs on the same queue.
export const INGESTION_PROMOTE_QUEUE = 'ingestion-promote'

// Google fetch runs on its own queue too — separate worker, separate rate limit.
export const INGESTION_GOOGLE_QUEUE = 'ingestion-google'

export const OVERPASS_FETCH_JOB = 'overpass-fetch-tile'

export const GOOGLE_FETCH_JOB = 'google-fetch-tile'

// Google searchNearby caps at 20 results per call, so tiles are smaller than OSM's.
// The search radius is derived per tile (see tileRadiusMeters) so it shrinks as tiles
// subdivide. 20 results back = likely truncation → subdivide.
export const DEFAULT_GOOGLE_TILE_DEGREES = 0.01
export const GOOGLE_MAX_RESULTS = 20

// When a Google tile returns the full 20-result cap it is likely truncated: re-fetch
// it as four quadrant subtiles, recursing until under the cap or this depth. At depth 3
// a 0.01° tile has shrunk ~8x per side (~140m), enough for the densest city cores.
export const GOOGLE_MAX_SUBDIVIDE_DEPTH = 3

// Refresh Google-cached fields before the ~30-day ToS limit.
export const GOOGLE_SYNC_TTL_DAYS = 25

export const INGESTION_REFRESH_QUEUE = 'ingestion-refresh'
export const GOOGLE_REFRESH_JOB = 'google-refresh-stale'

// Scheduler cadence and per-run bounds. Cost-capped: at most REFRESH_MAX_PER_RUN
// Place Details calls per run; leftover stale rows are picked up the next day.
export const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1_000
export const REFRESH_BATCH_SIZE = 50
export const REFRESH_MAX_PER_RUN = 200

// Tile edge in degrees (~5.5km at the equator). Small enough to keep Overpass
// responses under the timeout, large enough to bound request count.
export const DEFAULT_TILE_DEGREES = 0.05

export const DEFAULT_OVERPASS_URL = 'https://overpass-api.de/api/interpreter'

export const OVERPASS_TIMEOUT_MS = 90_000

// Overpass etiquette: identify the client. overpass-api.de returns 406 to the
// default undici/Node user-agent, so this header is required, not optional.
export const OVERPASS_USER_AGENT = 'sPark-ingestion/1.0 (+https://spark.gr)'

// Sweep orchestrator: fans a city/region list through osm+google fetch, waits for
// every tile to reach a terminal state, then drains promotion — one call, no manual
// per-bbox steps. Runs on its own queue so its polling never blocks a fetch worker.
export const INGESTION_SWEEP_QUEUE = 'ingestion-sweep'
export const SWEEP_JOB = 'sweep-regions'

// Poll cadence and ceiling while a sweep waits for its tiles to finish fetching.
// A dense multi-city sweep can queue many rate-limited tiles, so the ceiling is high;
// hitting it promotes whatever fetched rather than hanging forever.
export const SWEEP_POLL_INTERVAL_MS = 5_000
export const SWEEP_MAX_WAIT_MS = 60 * 60 * 1_000

// Named bounding boxes for the largest Greek urban areas, so a sweep can be driven by
// city name instead of hand-entered coordinates. [south, west, north, east].
export const GREEK_CITY_REGIONS: Record<string, [number, number, number, number]> = {
  athens: [37.9, 23.6, 38.05, 23.83],
  thessaloniki: [40.57, 22.9, 40.68, 23.02],
  patras: [38.22, 21.7, 38.29, 21.79],
  heraklion: [35.31, 25.1, 35.35, 25.17],
  larissa: [39.6, 22.39, 39.65, 22.44],
  volos: [39.34, 22.91, 39.38, 22.98],
  ioannina: [39.65, 20.83, 39.68, 20.88],
  chania: [35.5, 24.0, 35.53, 24.04],
}

export const PROMOTE_OSM_JOB = 'promote-osm-pending'

// Re-run OSM classification over facilities still kind=UNKNOWN. Shares the promote
// queue/worker since it is DB-only and must not overlap a drain of the same rows.
export const RECLASSIFY_JOB = 'reclassify-unknown'

// Rows promoted per DB round in the drain loop.
export const PROMOTE_BATCH_SIZE = 100

// Dedup: a candidate within this radius of an existing facility is a match when
// names are similar; within the tighter exact radius it matches regardless of name
// (two points that close are the same lot mapped twice).
export const DEDUP_RADIUS_METERS = 30
export const DEDUP_EXACT_METERS = 12
export const NAME_SIMILARITY_THRESHOLD = 0.4

// Synthetic operator owning ingested-but-unclaimed facilities until a real
// operator claims them. Fixed id so the upsert is idempotent.
export const UNCLAIMED_OPERATOR_ID = 'osm-unclaimed-operator'
export const UNCLAIMED_OPERATOR_NAME = 'Unclaimed (OSM Import)'
