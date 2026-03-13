export interface Coordinates {
  lat: number
  lng: number
}

const EARTH_RADIUS_METERS = 6371000
const METERS_PER_MILE = 1609.344

export function milesToMeters(miles: number): number {
  return miles * METERS_PER_MILE
}

export function metersToMiles(meters: number): number {
  return meters / METERS_PER_MILE
}

export function haversineDistanceMeters(from: Coordinates, to: Coordinates): number {
  const latitudeDelta = toRadians(to.lat - from.lat)
  const longitudeDelta = toRadians(to.lng - from.lng)
  const fromLatitude = toRadians(from.lat)
  const toLatitude = toRadians(to.lat)

  const value =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(fromLatitude) * Math.cos(toLatitude) * Math.sin(longitudeDelta / 2) ** 2

  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(value))
}

export function isWithinRadiusMiles(from: Coordinates, to: Coordinates, radiusMiles: number): boolean {
  return haversineDistanceMeters(from, to) <= milesToMeters(radiusMiles)
}

function toRadians(value: number): number {
  return (value * Math.PI) / 180
}
