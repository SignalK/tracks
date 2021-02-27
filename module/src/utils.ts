import { LatLngTuple, GeoBounds, QueryParameters, TrackParams, Debug } from './types'

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

export function validateParameters(params: QueryParameters, defaultMaxRadius: number | undefined): TrackParams {
  // bounding box lon1,lat1,lon2,lat2
  let bbox: GeoBounds | null = null
  if (typeof params.bbox !== 'undefined') {
    const b: number[] = params.bbox
      .split(',')
      .map((i: string | number) => {
        if (!isNaN(i as number)) {
          return parseFloat(i as string)
        }
      })
      .filter((i: number) => {
        if (typeof i === 'number') return i
      })
    bbox = b.length == 4 ? { sw: [b[0], b[1]], ne: [b[2], b[3]] } : null
  }

  let radius: number | null = null
  // radius in meters
  if (typeof params.radius !== 'undefined') {
    radius = !isNaN(params.radius) ? parseFloat(params.radius) : null
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
    if (debug && debug.enabled) {
      debug(`${[lat2d, lon2d]} => ${dk}`)
    }
    return dk
  }
}

const degreesToRadians = (value: number) => {
  return (Math.PI / 180) * value
}

function lastPoint(track: LatLngTuple[]): LatLngTuple | null {
  return track.length ? track[track.length - 1] : null
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
    const distanceFromSelf = createDistanceTo(selfPosition, debug)
    return (track: LatLngTuple[]) => distanceFromSelf(lastPoint(track)) < (params.radius as number)
  }
  return () => true
}
