import type { LatLngTuple, GeoBounds, QueryParameters, TrackParams, Debug } from './types.js'

const LAT = 0
const LNG = 1

// create function to check position against GeoBounds
export function createInBounds(bounds: GeoBounds): (position: LatLngTuple | null) => boolean {
  const minLat = bounds.sw[LAT]
  const maxLat = bounds.ne[LAT]
  if (minLat > maxLat) {
    throw new Error(`Bounding box south must be <=  north, got ${JSON.stringify(bounds)}`)
  }
  const minLng = bounds.sw[LNG]
  const maxLng = (bounds.sw[LNG] > bounds.ne[LNG] ? 360 : 0) + bounds.ne[LNG]

  return (p) => {
    return (
      p !== null &&
      p[LAT] >= minLat &&
      p[LAT] <= maxLat &&
      ((p[LNG] >= minLng && p[LNG] <= maxLng) || (p[LNG] + 360 >= minLng && p[LNG] + 360 <= maxLng))
    )
  }
}

/**
 * Express gives a repeated query parameter as an array. Take the first value so
 * `?radius=1&radius=2` degrades to a usable number rather than a parse failure.
 */
function firstValue(value: unknown): string | undefined {
  const scalar: unknown = Array.isArray(value) ? (value as unknown[])[0] : value
  return typeof scalar === 'string' ? scalar : undefined
}

/** Finite-only parse: rejects '', 'abc' and 'Infinity', all of which Number() lets through or maps to NaN. */
function toFiniteNumber(value: string): number | undefined {
  const trimmed = value.trim()
  if (trimmed === '') {
    return undefined
  }
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function validateParameters(params: QueryParameters, defaultMaxRadius: number | undefined): TrackParams {
  // bounding box lon1,lat1,lon2,lat2
  let bbox: GeoBounds | null = null
  const rawBbox = firstValue(params.bbox)
  if (rawBbox !== undefined) {
    const b = rawBbox.split(',').map(toFiniteNumber)
    // Every one of the four must have parsed; a `0` is a valid coordinate, so
    // test for undefined rather than truthiness.
    const [swLat, swLng, neLat, neLng] = b
    if (b.length === 4 && swLat !== undefined && swLng !== undefined && neLat !== undefined && neLng !== undefined) {
      bbox = { sw: [swLat, swLng], ne: [neLat, neLng] }
    }
  }

  let radius: number | null = null
  // radius in meters
  const rawRadius = firstValue(params.radius)
  if (rawRadius !== undefined) {
    radius = toFiniteNumber(rawRadius) ?? null
  } else if (defaultMaxRadius) {
    radius = defaultMaxRadius
  }
  return { bbox, radius }
}

//Create function to calculate distance to a point
export function createDistanceTo([lat1d, lon1d]: LatLngTuple, debug?: Debug): (d: LatLngTuple | null) => number {
  const Rk = 6371 // mean radius of the earth (km) at 39 degrees from the equator

  // convert coordinates to radians
  const lat1 = degreesToRadians(lat1d)
  const lon1 = degreesToRadians(lon1d)

  return (dest) => {
    if (!dest) {
      return Number.MAX_SAFE_INTEGER
    }
    const [lat2d, lon2d] = dest
    const lat2 = degreesToRadians(lat2d)
    const lon2 = degreesToRadians(lon2d)

    // find the differences between the coordinates
    const dlat = lat2 - lat1
    const dlon = lon2 - lon1

    //** calculate **
    const a = Math.pow(Math.sin(dlat / 2), 2) + Math.cos(lat1) * Math.cos(lat2) * Math.pow(Math.sin(dlon / 2), 2)
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
    const dk = c * Rk * 1000 // great circle distance in m
    if (debug?.enabled) {
      debug(`${lat2d},${lon2d} => ${dk}`)
    }
    return dk
  }
}

const degreesToRadians = (value: number) => {
  return (Math.PI / 180) * value
}

function lastPoint(track: LatLngTuple[]): LatLngTuple | null {
  return track.at(-1) ?? null
}

// Positions are accumulated under the context carried by the delta, which for
// the own vessel is always the fully qualified context (vessels.urn:mrn:...),
// never the literal `vessels.self`. Resolve the `self` alias the rest of the
// Signal K HTTP API accepts so a lookup for it can hit.
export function resolveContext(vesselId: string, selfContext?: string): string {
  if ((vesselId === 'self' || vesselId === 'vessels.self') && selfContext) {
    return selfContext
  }
  return vesselId.startsWith('vessels.') ? vesselId : `vessels.${vesselId}`
}

export function createMatcher(
  params: TrackParams,
  selfPosition?: LatLngTuple,
  debug?: Debug,
): (track: LatLngTuple[]) => boolean {
  if (params.bbox) {
    const inBounds = createInBounds(params.bbox)
    return (track: LatLngTuple[]) => inBounds(lastPoint(track))
  } else if (params.radius !== null) {
    if (!selfPosition) {
      throw new Error('No self position to calculate radius values')
    }
    const radius = params.radius
    const distanceFromSelf = createDistanceTo(selfPosition, debug)
    return (track: LatLngTuple[]) => distanceFromSelf(lastPoint(track)) < radius
  }
  return () => true
}
