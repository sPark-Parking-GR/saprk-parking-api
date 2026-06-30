export const INGESTION_QUEUE = 'ingestion'

// Promotion runs on its own queue so its worker never competes with the
// rate-limited Overpass fetch worker for jobs on the same queue.
export const INGESTION_PROMOTE_QUEUE = 'ingestion-promote'

// Google fetch runs on its own queue too — separate worker, separate rate limit.
export const INGESTION_GOOGLE_QUEUE = 'ingestion-google'

export const OVERPASS_FETCH_JOB = 'overpass-fetch-tile'

export const GOOGLE_FETCH_JOB = 'google-fetch-tile'

// Google searchNearby caps at 20 results per call, so tiles are smaller than OSM's
// and a circle is inscribed per tile. 20 results back = likely truncation → logged.
export const DEFAULT_GOOGLE_TILE_DEGREES = 0.01
export const GOOGLE_NEARBY_RADIUS_METERS = 800
export const GOOGLE_MAX_RESULTS = 20

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

export const PROMOTE_OSM_JOB = 'promote-osm-pending'

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
