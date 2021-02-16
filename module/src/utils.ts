// ** utility functions **

import { LatLngTuple, GeoBounds, Position, QueryParameters } from './types'

// ** check position is in bounds
export function inBounds(position: LatLngTuple, bounds: GeoBounds): boolean {
  if (position && typeof position[0] == 'number' && typeof position[1] == 'number') {
    let dlBounds= JSON.parse(JSON.stringify(bounds))
    let dlPosition= [position[0],position[1]]
    // date line crossing?
    if (dlBounds.sw[0] > 0 && dlBounds.ne[0] < 0) {
      dlBounds.ne[0] = 360 + dlBounds.ne[0]
      if (dlPosition[0] < 0) {
        dlPosition[0] = 360 + dlPosition[0]
      }
    }
    return dlPosition[1] >= dlBounds.sw[1] &&
      dlPosition[1] <= dlBounds.ne[1] &&
      dlPosition[0] >= dlBounds.sw[0] &&
      dlPosition[0] <= dlBounds.ne[0]
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
    let b: number[] = params.bbox
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
  let lat1 = degreesToRadians(srcpt.latitude)
  let lon1 = degreesToRadians(srcpt.longitude)
  let lat2 = degreesToRadians(destpt.latitude)
  let lon2 = degreesToRadians(destpt.longitude)

  // find the differences between the coordinates
  let dlat = lat2 - lat1
  let dlon = lon2 - lon1

  //** calculate **
  let a = Math.pow(Math.sin(dlat / 2), 2) + Math.cos(lat1) * Math.cos(lat2) * Math.pow(Math.sin(dlon / 2), 2)
  let c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  let dk = c * Rk * 1000 // great circle distance in m
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
