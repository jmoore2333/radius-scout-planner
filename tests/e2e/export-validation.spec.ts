import { expect, test } from '@playwright/test'
import { createScout, waitForMapReady, waitForProviderCards } from './helpers'

test('CSV export returns 400 when scoutProfileId is missing', async ({ request }) => {
  const response = await request.get('/api/export.csv')
  expect(response.status()).toBe(400)

  const body = await response.json()
  expect(body.error).toBe('scoutProfileId is required.')
})

test('GeoJSON export returns 400 when scoutProfileId is missing', async ({ request }) => {
  const response = await request.get('/api/export.geojson')
  expect(response.status()).toBe(400)

  const body = await response.json()
  expect(body.error).toBe('scoutProfileId is required.')
})

test('CSV export with a valid but empty scout returns 200 with only headers', async ({ page, request }) => {
  await page.goto('/')
  await waitForMapReady(page)
  await waitForProviderCards(page)
  const scoutId = await createScout(page, `export-empty-${Date.now()}`)

  const response = await request.get(`/api/export.csv?scoutProfileId=${scoutId}`)
  expect(response.status()).toBe(200)
  expect(response.headers()['content-type']).toContain('text/csv')

  const body = await response.text()
  const lines = body.trim().split('\n')
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('queue_item_id')
  expect(lines[0]).toContain('status')
  expect(lines[0]).toContain('name')
})

test('GeoJSON export with a valid but empty scout returns an empty FeatureCollection', async ({ page, request }) => {
  await page.goto('/')
  await waitForMapReady(page)
  await waitForProviderCards(page)
  const scoutId = await createScout(page, `export-empty-geo-${Date.now()}`)

  const response = await request.get(`/api/export.geojson?scoutProfileId=${scoutId}`)
  expect(response.status()).toBe(200)

  const body = await response.json()
  expect(body.type).toBe('FeatureCollection')
  expect(Array.isArray(body.features)).toBeTruthy()
  expect(body.features).toHaveLength(0)
})

test('CSV export with a non-existent scoutProfileId returns 200 with empty data', async ({ request }) => {
  const fakeId = '00000000-0000-0000-0000-000000000000'
  const response = await request.get(`/api/export.csv?scoutProfileId=${fakeId}`)
  expect(response.status()).toBe(200)

  const body = await response.text()
  const lines = body.trim().split('\n')
  // Should contain the CSV header row but no data rows
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('queue_item_id')
})

test('GeoJSON export with a non-existent scoutProfileId returns 200 with empty features', async ({ request }) => {
  const fakeId = '00000000-0000-0000-0000-000000000000'
  const response = await request.get(`/api/export.geojson?scoutProfileId=${fakeId}`)
  expect(response.status()).toBe(200)

  const body = await response.json()
  expect(body.type).toBe('FeatureCollection')
  expect(Array.isArray(body.features)).toBeTruthy()
  expect(body.features).toHaveLength(0)
})
