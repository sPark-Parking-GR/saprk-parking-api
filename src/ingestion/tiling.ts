export interface Tile {
  south: number
  west: number
  north: number
  east: number
}

export interface BoundingBox {
  south: number
  west: number
  north: number
  east: number
}

// Round to 7 decimals to match the Decimal(10,7) tile columns so repeated runs
// produce byte-identical bounds and the IngestTile unique constraint dedupes.
const round7 = (n: number): number => Math.round(n * 1e7) / 1e7

// Index-based stepping avoids float accumulation drift that would otherwise spawn
// a spurious sliver row/column. The epsilon absorbs the 0.1/0.05 = 2.0000000004
// kind of representation error so exact multiples yield the exact tile count.
const EPSILON = 1e-9

// Circumscribed radius (metres) of a tile: the Google searchNearby radius must reach
// the tile corners to cover it, and must SHRINK with the tile — otherwise a subdivided
// tile still searches the parent-sized circle, re-catching the same 20 results and
// defeating the subdivision. Derived per tile from its own span, not a constant.
const METERS_PER_DEGREE = 111_320

export function tileRadiusMeters(tile: Tile): number {
  const heightM = (tile.north - tile.south) * METERS_PER_DEGREE
  const midLatRad = (((tile.south + tile.north) / 2) * Math.PI) / 180
  const widthM = (tile.east - tile.west) * METERS_PER_DEGREE * Math.cos(midLatRad)
  return Math.max(1, Math.round(0.5 * Math.hypot(heightM, widthM)))
}

// Split one tile into its four quadrants. Used to recover Google results lost to the
// 20-per-call cap: a tile that truncates is re-fetched as four smaller tiles. Bounds
// are round7'd to match the Decimal(10,7) columns so the IngestTile unique constraint
// dedupes a re-subdivided tile.
export function quadrants(tile: Tile): Tile[] {
  const midLat = round7((tile.south + tile.north) / 2)
  const midLng = round7((tile.west + tile.east) / 2)
  const south = round7(tile.south)
  const west = round7(tile.west)
  const north = round7(tile.north)
  const east = round7(tile.east)
  return [
    { south, west, north: midLat, east: midLng },
    { south, west: midLng, north: midLat, east },
    { south: midLat, west, north, east: midLng },
    { south: midLat, west: midLng, north, east },
  ]
}

export function splitBoundingBox(bounds: BoundingBox, tileDegrees: number): Tile[] {
  const rows = Math.max(1, Math.ceil((bounds.north - bounds.south) / tileDegrees - EPSILON))
  const cols = Math.max(1, Math.ceil((bounds.east - bounds.west) / tileDegrees - EPSILON))

  const tiles: Tile[] = []
  for (let r = 0; r < rows; r++) {
    const south = bounds.south + r * tileDegrees
    const north = Math.min(south + tileDegrees, bounds.north)
    for (let c = 0; c < cols; c++) {
      const west = bounds.west + c * tileDegrees
      const east = Math.min(west + tileDegrees, bounds.east)
      tiles.push({
        south: round7(south),
        west: round7(west),
        north: round7(north),
        east: round7(east),
      })
    }
  }
  return tiles
}
