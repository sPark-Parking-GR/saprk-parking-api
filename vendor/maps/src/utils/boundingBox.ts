import type { BoundingBox, LatLng } from '@spark/types'

const EARTH_RADIUS_METERS = 6_378_137

export function computeBoundingBox(center: LatLng, radiusMeters: number): BoundingBox {
  const latDelta = (radiusMeters / EARTH_RADIUS_METERS) * (180 / Math.PI)
  const lngDelta =
    (radiusMeters / (EARTH_RADIUS_METERS * Math.cos((center.lat * Math.PI) / 180))) *
    (180 / Math.PI)

  return {
    northeast: { lat: center.lat + latDelta, lng: center.lng + lngDelta },
    southwest: { lat: center.lat - latDelta, lng: center.lng - lngDelta },
  }
}
