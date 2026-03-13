export function formatDistanceMiles(value: number): string {
  if (value < 1) {
    return `${value.toFixed(1)} mi`
  }

  return `${value.toFixed(0)} mi`
}

export function formatCoordinate(value: number): string {
  return value.toFixed(6)
}
