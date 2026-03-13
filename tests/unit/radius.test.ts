import { describe, expect, it } from 'vitest'
import { buildQueueCsv, buildQueueGeoJson } from '../../edge/lib/export'
import { haversineDistanceMeters, isWithinRadiusMiles, milesToMeters } from '../../shared/radius'
import type { QueueItemDetail } from '../../shared/types'

describe('radius helpers', () => {
  it('converts miles to meters', () => {
    expect(milesToMeters(1)).toBeCloseTo(1609.344, 3)
  })

  it('computes haversine distance between two coordinates', () => {
    const distance = haversineDistanceMeters(
      { lat: 38.8977, lng: -77.0365 },
      { lat: 38.8893, lng: -77.0502 },
    )

    expect(distance).toBeGreaterThan(1000)
    expect(distance).toBeLessThan(2000)
  })

  it('determines whether a point is inside a radius in miles', () => {
    expect(
      isWithinRadiusMiles(
        { lat: 38.8977, lng: -77.0365 },
        { lat: 38.8893, lng: -77.0502 },
        2,
      ),
    ).toBe(true)
  })
})

describe('export helpers', () => {
  const sampleQueueItem: QueueItemDetail = {
    id: 'queue-1',
    status: 'queued',
    distanceMiles: 4.2,
    interestReason: 'Hospital campus',
    createdAt: '2026-03-08T00:00:00.000Z',
    updatedAt: '2026-03-08T00:00:00.000Z',
    poi: {
      id: 'poi-1',
      providerPlaceKey: 'osm:node:1',
      name: 'Capital Hospital',
      category: 'hospitals',
      rawCategories: ['amenity:hospital'],
      address: '100 Main St, Washington, DC',
      lat: 38.9,
      lng: -77.04,
      distanceMiles: 4.2,
      website: null,
      phone: null,
      queueItem: null,
    },
    notes: [
      {
        id: 'note-1',
        note: 'Check helipad sightline.',
        createdAt: '2026-03-08T00:00:00.000Z',
        authorAccessEmail: 'pilot@example.com',
      },
    ],
    media: [],
  }

  it('builds csv export rows', () => {
    const csv = buildQueueCsv([
      {
        ...sampleQueueItem,
        status: 'photographed',
        media: [
          {
            id: 'media-1',
            queueItemId: 'queue-1',
            poiId: 'poi-1',
            url: 'https://example.com/media-1.jpg',
            fileName: 'media-1.jpg',
            contentType: 'image/jpeg',
            sizeBytes: 1024,
            caption: 'Overview frame',
            createdAt: '2026-03-08T00:00:00.000Z',
          },
        ],
      },
    ])

    expect(csv).toContain('queue_item_id')
    expect(csv).toContain('Capital Hospital')
    expect(csv).toContain('photographed')
    expect(csv).toContain('"1"')
  })

  it('builds geojson export features', () => {
    const geojson = buildQueueGeoJson([
      {
        ...sampleQueueItem,
        media: [
          {
            id: 'media-1',
            queueItemId: 'queue-1',
            poiId: 'poi-1',
            url: 'https://example.com/media-1.jpg',
            fileName: 'media-1.jpg',
            contentType: 'image/jpeg',
            sizeBytes: 1024,
            caption: 'Overview frame',
            createdAt: '2026-03-08T00:00:00.000Z',
          },
        ],
      },
    ])

    expect(geojson.type).toBe('FeatureCollection')
    expect(geojson.features).toHaveLength(1)
    expect(geojson.features[0]?.properties.name).toBe('Capital Hospital')
    expect(geojson.features[0]?.properties.mediaCount).toBe(1)
  })
})
