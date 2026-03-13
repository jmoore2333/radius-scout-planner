import type { QueueItemDetail } from '../../shared/types'

function escapeCsv(value: string | number | null): string {
  if (value === null) {
    return ''
  }

  return `"${String(value).replaceAll('"', '""')}"`
}

export function buildQueueCsv(items: QueueItemDetail[]): string {
  const rows = [
    ['queue_item_id', 'status', 'name', 'category', 'address', 'lat', 'lng', 'distance_miles', 'note_count', 'media_count'].join(','),
  ]

  for (const item of items) {
    rows.push(
      [
        escapeCsv(item.id),
        escapeCsv(item.status),
        escapeCsv(item.poi.name),
        escapeCsv(item.poi.category),
        escapeCsv(item.poi.address),
        escapeCsv(item.poi.lat.toFixed(6)),
        escapeCsv(item.poi.lng.toFixed(6)),
        escapeCsv(item.distanceMiles.toFixed(2)),
        escapeCsv(item.notes.length),
        escapeCsv(item.media.length),
      ].join(','),
    )
  }

  return rows.join('\n')
}

export function buildQueueGeoJson(items: QueueItemDetail[]) {
  return {
    type: 'FeatureCollection',
    features: items.map(item => ({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [item.poi.lng, item.poi.lat],
      },
      properties: {
        queueItemId: item.id,
        status: item.status,
        category: item.poi.category,
        name: item.poi.name,
        address: item.poi.address,
        distanceMiles: item.distanceMiles,
        noteCount: item.notes.length,
        mediaCount: item.media.length,
      },
    })),
  }
}
