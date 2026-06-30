import { splitBoundingBox } from './tiling'

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
