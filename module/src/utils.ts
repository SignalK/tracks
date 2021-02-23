// ** utility functions **

import { LatLngTuple, GeoBounds, Position, QueryParameters } from './types'

// ** Align bounding box valjues to reflect spanning the date line
export function bboxDateLineAlign(bounds: GeoBounds) {
  if (bounds.sw[0] > 0 && bounds.ne[0] < 0) {
    bounds.ne[0] = 360 + bounds.ne[0]
  }
  return bounds
}

// ** check position is in bounds
export function inBounds(position: LatLngTuple, bounds: GeoBounds): boolean {
  if (position && typeof position[0] == 'number' && typeof position[1] == 'number') {
    const dlPosition = [position[0], position[1]]
    if (bounds.ne[0] > 180) {  // date line spanned?
      if (dlPosition[0] < 0) {
        dlPosition[0] = 360 + dlPosition[0]
      }
    }
    return dlPosition[1] >= bounds.sw[1] &&
      dlPosition[1] <= bounds.ne[1] &&
      dlPosition[0] >= bounds.sw[0] &&
      dlPosition[0] <= bounds.ne[0]
      ? true
      : false
  } else {
    return false
  }
}

// validate query parameters
export function validateParameters(params: QueryParameters) {
  // bounding box lon1,lat1,lon2,lat2
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
    params.bbox = b.length == 4 ? { sw: [b[0], b[1]], ne: [b[2], b[3]] } : null
  }
  // radius in meters
  if (typeof params.radius !== 'undefined') {
    params.radius = !isNaN(params.radius) ? parseFloat(params.radius) : null
  }
  return params
}

//** Calculate the distance between two points in meters
export function distanceTo(srcpt: Position, destpt: Position) {
  const Rk = 6371 // mean radius of the earth (km) at 39 degrees from the equator

  // convert coordinates to radians
  const lat1 = degreesToRadians(srcpt.latitude)
  const lon1 = degreesToRadians(srcpt.longitude)
  const lat2 = degreesToRadians(destpt.latitude)
  const lon2 = degreesToRadians(destpt.longitude)

  // find the differences between the coordinates
  const dlat = lat2 - lat1
  const dlon = lon2 - lon1

  //** calculate **
  const a = Math.pow(Math.sin(dlat / 2), 2) + Math.cos(lat1) * Math.cos(lat2) * Math.pow(Math.sin(dlon / 2), 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  const dk = c * Rk * 1000 // great circle distance in m
  return dk
}

const degreesToRadians = (value: number) => {
  return (Math.PI / 180) * value
}

export function latLonTupleToPosition(value: LatLngTuple): Position {
  return {
    longitude: value[0],
    latitude: value[1],
  }
}
