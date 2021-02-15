export type Context = string

export type LatLngTuple = [number, number]

export interface Position {
  latitude: number
  longitude: number
}

export interface VesselCollection { [key: string] : LatLngTuple[] }

export interface GeoBounds {
  ne: LatLngTuple;
  sw: LatLngTuple;
}

export interface QueryParameters { [key: string] : any }

