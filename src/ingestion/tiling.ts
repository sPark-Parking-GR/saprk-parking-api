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
