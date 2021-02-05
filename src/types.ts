export type Context = string

export interface Position {
  latitude: number
  longitude: number
}

export interface Config {
  resolution: number
  pointsToKeep: number
  maxAge: number
}

export interface VesselCollection { [key: string] : Position[] }