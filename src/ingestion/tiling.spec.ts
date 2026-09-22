import { quadrants, splitBoundingBox, tileRadiusMeters } from './tiling'

describe('splitBoundingBox', () => {
  it('returns a single tile when the region fits one tile', () => {
    const tiles = splitBoundingBox({ south: 37.97, west: 23.71, north: 37.99, east: 23.73 }, 0.05)
    expect(tiles).toHaveLength(1)
    expect(tiles[0]).toEqual({ south: 37.97, west: 23.71, north: 37.99, east: 23.73 })
  })

  it('grids a region into rows × cols tiles', () => {
    const tiles = splitBoundingBox({ south: 37.9, west: 23.7, north: 38.0, east: 23.8 }, 0.05)
    expect(tiles).toHaveLength(4)
  })

  it('clamps the trailing tile to the region bounds', () => {
    const tiles = splitBoundingBox({ south: 0, west: 0, north: 0.07, east: 0.05 }, 0.05)
    expect(tiles).toHaveLength(2)
    const last = tiles[tiles.length - 1]!
    expect(last.north).toBe(0.07)
    expect(last.east).toBe(0.05)
  })

  it('rounds every bound to 7 decimal places', () => {
    const tiles = splitBoundingBox({ south: 0, west: 0, north: 0.1, east: 0.05 }, 0.03)
    for (const t of tiles) {
      for (const v of [t.south, t.west, t.north, t.east]) {
        expect(v).toBe(Math.round(v * 1e7) / 1e7)
      }
    }
  })
})

describe('quadrants', () => {
  it('splits a tile into four equal, gap-free, non-overlapping quarters', () => {
    const quads = quadrants({ south: 0, west: 0, north: 0.02, east: 0.02 })
    expect(quads).toEqual([
      { south: 0, west: 0, north: 0.01, east: 0.01 },
      { south: 0, west: 0.01, north: 0.01, east: 0.02 },
      { south: 0.01, west: 0, north: 0.02, east: 0.01 },
      { south: 0.01, west: 0.01, north: 0.02, east: 0.02 },
    ])
  })

  it('rounds the midpoint to 7 decimals so re-subdivision dedupes on the tile key', () => {
    const [first] = quadrants({ south: 0, west: 0, north: 0.0000003, east: 0.0000003 })
    expect(first!.north).toBe(Math.round(first!.north * 1e7) / 1e7)
  })
})

describe('tileRadiusMeters', () => {
  it('circumscribes a 0.01° tile at Greek latitudes near ~700m', () => {
    const r = tileRadiusMeters({ south: 40.6, west: 22.95, north: 40.61, east: 22.96 })
    expect(r).toBeGreaterThan(600)
    expect(r).toBeLessThan(800)
  })

  it('halves as the tile subdivides, so subtiles narrow the search', () => {
    const parent = { south: 40.6, west: 22.95, north: 40.62, east: 22.97 }
    const child = quadrants(parent)[0]!
    expect(tileRadiusMeters(child)).toBeLessThan(tileRadiusMeters(parent) * 0.6)
  })
})
