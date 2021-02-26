export type Context = string

export type LatLngTuple = [number, number]
export type LngLatTuple = [number, number]

export interface Position {
  latitude: number
  longitude: number
}

export interface TrackCollection {
  [key: string]: LatLngTuple[]
}

export interface GeoBounds {
  ne: LatLngTuple
  sw: LatLngTuple
}

export interface QueryParameters {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any
}

export interface TrackParams {
  bbox: GeoBounds | null
  radius: number | null
}

export interface Debug {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (...args: any): any
  enabled: boolean
}
