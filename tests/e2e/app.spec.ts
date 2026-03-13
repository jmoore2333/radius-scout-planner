import { expect, test } from '@playwright/test'
import {
  assertNoWorkerErrors,
  createScout,
  LARGE_RADIUS_BETA_MESSAGE,
  queueCardByName,
  readLiveMapViewport,
  runSearch,
  setCategories,
  uploadNearbyCaptureProof,
  uploadTinyImage,
  waitForMapReady,
  waitForProviderCards,
  waitForRememberedScout,
} from './helpers'

test('searches, queues a POI, uploads field evidence, restores saved pins, and exports persisted data', async ({ page, request }) => {
  const scoutName = `smoke-e2e-${Date.now()}`

  await page.goto('/')
  await waitForMapReady(page)
  await waitForProviderCards(page)
  await expect(page.locator('.provider-card')).toContainText(['Azure Maps Search', 'Mapbox map loads'])
  const scoutId = await createScout(page, scoutName)

  await runSearch(page, {
    origin: '100 N Queen St, Lancaster, PA 17603',
    radiusLabel: '10 mi',
    categories: ['hospitals', 'malls'],
  })

  const firstResult = page.getByTestId('result-list').locator('.result-card').first()
  await expect(firstResult).toBeVisible({ timeout: 60_000 })
  const queuedPoiName = (await firstResult.locator('strong').textContent())?.trim() ?? ''
  await firstResult.click()
  await page.getByRole('textbox', { name: 'Why this matters' }).fill(
    'Hospital campus with rooftop, parking, and approach angles worth scouting.',
  )
  await page.getByRole('textbox', { name: 'Field note' }).fill(
    'Check rooftop clutter, ambulance approach visibility, and alternate oblique angles.',
  )
  await page.getByTestId('queue-button').click()

  const queueCard = queueCardByName(page, queuedPoiName)
  await expect(queueCard).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('.detail-story')).toContainText('0 uploads')

  await uploadTinyImage(queueCard.locator('input[type="file"]'))
  await expect(queueCard).toContainText('1 uploads', { timeout: 60_000 })
  await expect(page.locator('.gallery-card').first()).toContainText(queuedPoiName)

  await page.getByRole('combobox', { name: 'Queue status' }).selectOption('photographed')
  await page.getByTestId('queue-button').click()
  await expect(page.locator('.detail-story')).toContainText('photographed')

  const csvButton = page.getByRole('button', { name: 'CSV' })
  const geoJsonButton = page.getByRole('button', { name: 'GeoJSON' })
  await expect(csvButton).toBeVisible()
  await expect(geoJsonButton).toBeVisible()
  await expect(page.locator('.history-card').first()).toBeVisible()
  await waitForRememberedScout(page, scoutId)

  await page.reload()
  await waitForMapReady(page)
  await expect.poll(() => page.getByTestId('scout-select').inputValue(), { timeout: 15_000 }).toBe(scoutId)
  await expect(page.getByRole('heading', { name: '1 saved scout pins ready for review' })).toBeVisible()
  // Enable "photographed" filter (hidden by default) so the queue card is visible
  await page.getByTestId('queue-filters').getByLabel(/photographed/).check()
  await expect(page.getByTestId('queue-list').locator('.queue-card').first()).toContainText(queuedPoiName)
  await expect(page.locator('.gallery-card').first()).toContainText(queuedPoiName)
  await expect(page.locator('.history-card').first()).toBeVisible()

  await page.getByRole('button', { name: 'Show pin' }).click()
  await expect(page.getByRole('heading', { name: queuedPoiName })).toBeVisible()

  const mediaHref = await page.getByRole('link', { name: 'Open asset' }).first().getAttribute('href')
  expect(mediaHref).toBeTruthy()
  if (process.env.APP_BASE_URL) {
    const mediaResponse = await request.get(mediaHref!)
    expect(mediaResponse.ok()).toBeTruthy()
    expect(mediaResponse.headers()['content-type']).toContain('image/')
  }

  await page.locator('.history-card').first().click()
  await expect(page.getByTestId('result-list').locator('.result-card').first()).toBeVisible({ timeout: 60_000 })

  const csvHref = await csvLink.getAttribute('href')
  const geoJsonHref = await geoJsonLink.getAttribute('href')
  expect(csvHref).toBeTruthy()
  expect(geoJsonHref).toBeTruthy()

  const csvResponse = await request.get(csvHref!)
  expect(csvResponse.ok()).toBeTruthy()
  const csvBody = await csvResponse.text()
  expect(csvBody).toContain(queuedPoiName)
  expect(csvBody).toContain('photographed')
  expect(csvBody).toContain('"1"')

  const geoJsonResponse = await request.get(geoJsonHref!)
  expect(geoJsonResponse.ok()).toBeTruthy()
  const geoJsonBody = await geoJsonResponse.json()
  expect(Array.isArray(geoJsonBody.features)).toBeTruthy()
  expect(geoJsonBody.features.length).toBeGreaterThan(0)
  const queuedFeature = geoJsonBody.features.find((feature: { properties: { name: string } }) => feature.properties.name === queuedPoiName)
  expect(queuedFeature?.properties.status).toBe('photographed')
  expect(queuedFeature?.properties.mediaCount).toBe(1)
})

test('supports switching between scout profiles without mixing queue data', async ({ page }) => {
  const scoutA = `smoke-e2e-a-${Date.now()}`
  const scoutB = `smoke-e2e-b-${Date.now()}`

  await page.goto('/')
  await waitForMapReady(page)
  await createScout(page, scoutA)
  await runSearch(page, {
    origin: '1600 Pennsylvania Ave NW, Washington, DC 20500',
    radiusLabel: '10 mi',
    categories: ['hospitals', 'schools', 'malls'],
  })
  await expect(page.getByTestId('result-list').locator('.result-card').first()).toBeVisible({ timeout: 60_000 })
  const firstResult = page.getByTestId('result-list').locator('.result-card').first()
  const queuedPoiName = (await firstResult.locator('strong').textContent())?.trim() ?? ''
  await firstResult.click()
  await page.getByTestId('queue-button').click()
  await expect(page.getByTestId('queue-list').locator('.queue-card')).toHaveCount(1, { timeout: 60_000 })

  await createScout(page, scoutB)
  await expect(page.getByTestId('queue-list').locator('.queue-card')).toHaveCount(0)
  await expect(page.locator('.history-card')).toHaveCount(0)
  await expect(page.locator('.gallery-card')).toHaveCount(0)

  await page.getByTestId('scout-select').selectOption({ label: scoutA })
  await expect(page.getByTestId('queue-list').locator('.queue-card')).toHaveCount(1, { timeout: 60_000 })
  await expect(page.locator('.history-card')).toHaveCount(1, { timeout: 60_000 })
  await expect(page.getByRole('heading', { name: '1 saved scout pins ready for review' })).toBeVisible()
  await expect(queueCardByName(page, queuedPoiName)).toBeVisible()

  if (process.env.APP_BASE_URL) {
    await expect
      .poll(async () => {
        const viewport = await readLiveMapViewport(page)
        return viewport ? Number(viewport.zoom.toFixed(1)) : null
      }, { timeout: 60_000 })
      .not.toBeNull()
  }
})

test('clusters dense searches and focuses the live map on uploaded capture metadata', async ({ page }) => {
  const scoutName = `smoke-e2e-capture-${Date.now()}`

  await page.goto('/')
  await waitForMapReady(page)
  await createScout(page, scoutName)

  await page.getByTestId('origin-input').fill('350 5th Ave, New York, NY 10118')
  await page.getByTestId('radius-grid').getByRole('button', { name: '10 mi', exact: true }).click()
  await setCategories(page, ['hospitals', 'schools', 'malls', 'restaurants', 'coffee_shops', 'movie_theaters'])
  await page.getByTestId('search-button').click()
  await expect(page.getByTestId('result-list').locator('.result-card').first()).toBeVisible({ timeout: 60_000 })

  if (process.env.APP_BASE_URL) {
    await expect
      .poll(async () => (await readLiveMapViewport(page))?.clusterCount ?? 0, { timeout: 60_000 })
      .toBeGreaterThan(0)
  }

  const amcResult = page.getByTestId('result-list').getByRole('button', { name: /AMC 34th Street 14/i }).first()
  await expect(amcResult).toBeVisible({ timeout: 60_000 })
  await amcResult.click()
  await page.getByRole('textbox', { name: 'Why this matters' }).fill(
    'Midtown theater anchor with marquee lighting and rooftop context worth a twilight drone pass.',
  )
  await page.getByRole('textbox', { name: 'Field note' }).fill(
    'Use this as the metadata proof path: queue, upload a GPS-tagged proof image, and focus the capture point on the live map.',
  )
  await page.getByTestId('queue-button').click()

  const queueCard = queueCardByName(page, 'AMC 34th Street 14')
  await expect(queueCard).toBeVisible({ timeout: 60_000 })
  await uploadNearbyCaptureProof(queueCard.locator('input[type="file"]'))
  await expect(page.locator('.detail-story')).toContainText('DJI Mini 4 Pro', { timeout: 60_000 })
  await expect(page.locator('.detail-story')).toContainText('mi from saved POI', { timeout: 60_000 })

  const captureCard = page.locator('.detail-story .media-card').filter({ hasText: 'DJI Mini 4 Pro' }).first()
  await captureCard.getByRole('button', { name: 'Show capture' }).click()

  if (process.env.APP_BASE_URL) {
    await expect
      .poll(async () => {
        const viewport = await readLiveMapViewport(page)
        if (!viewport) {
          return false
        }

        return (
          Math.abs(viewport.lat - 40.753) <= 0.01
          && Math.abs(viewport.lng - -73.993) <= 0.01
          && viewport.zoom >= 14
        )
      })
      .toBe(true)
  }

  await page.reload()
  await waitForMapReady(page)
  await expect(page.getByRole('heading', { name: '1 saved scout pins ready for review' })).toBeVisible({ timeout: 60_000 })
  await expect(queueCardByName(page, 'AMC 34th Street 14')).toBeVisible({ timeout: 60_000 })

  if (process.env.APP_BASE_URL) {
    await expect
      .poll(async () => {
        const viewport = await readLiveMapViewport(page)
        if (!viewport) {
          return false
        }

        return (
          Math.abs(viewport.lat - 40.748) <= 0.02
          && Math.abs(viewport.lng - -73.986) <= 0.02
        )
      })
      .toBe(true)
  }
})

test('searches using map center when no address is entered', async ({ page }) => {
  const scoutName = `map-center-${Date.now()}`

  await page.goto('/')
  await waitForMapReady(page)
  await createScout(page, scoutName)

  // Clear origin input — search should fall back to current map center
  await page.getByTestId('origin-input').fill('')
  await setCategories(page, ['hospitals'])
  await page.getByTestId('radius-grid').getByRole('button', { name: '10 mi', exact: true }).click()

  await page.getByTestId('search-button').click()
  await expect(page.getByTestId('result-list').locator('.result-card').first()).toBeVisible({ timeout: 60_000 })
  await assertNoWorkerErrors(page)

  // Origin label should show coordinates since no text was entered
  const originValue = await page.getByTestId('origin-input').inputValue()
  expect(originValue).toMatch(/\d+\.\d+/)
})

test('shows error message when searching without a scout profile selected', async ({ page }) => {
  // Intercept session to return empty profiles so no scout is auto-selected
  await page.route('**/api/session', async route => {
    const response = await route.fetch()
    const body = await response.json()
    await route.fulfill({ response, body: JSON.stringify({ ...body, profiles: [] }) })
  })

  await page.goto('/')
  await waitForMapReady(page)
  await waitForProviderCards(page)

  // Attempt to search without a scout profile
  await page.getByTestId('origin-input').fill('Lancaster, PA')
  await page.getByTestId('search-button').click()

  // Should show the "create or select" message
  const toast = page.locator('.toast')
  await expect(toast).toContainText('Create or select a scout profile first', { timeout: 10_000 })
})

test('Use map center button runs search using current map coordinates', async ({ page }) => {
  const scoutName = `map-btn-${Date.now()}`

  await page.goto('/')
  await waitForMapReady(page)
  await waitForProviderCards(page)
  await createScout(page, scoutName)

  await setCategories(page, ['hospitals'])
  await page.getByTestId('radius-grid').getByRole('button', { name: '10 mi', exact: true }).click()

  // Click the explicit "Use map center" button
  await page.getByRole('button', { name: 'Use map center' }).click()
  await expect(page.getByTestId('result-list').locator('.result-card').first()).toBeVisible({ timeout: 60_000 })
  await assertNoWorkerErrors(page)

  // Origin should show coordinate-style label (not a place name from geocoding)
  const originValue = await page.getByTestId('origin-input').inputValue()
  expect(originValue).toMatch(/\d+\.\d+/)
})

test('OpenStreetMap link renders with correct URL format', async ({ page }) => {
  await page.goto('/')
  await waitForMapReady(page)
  await waitForProviderCards(page)
  await createScout(page, `osm-link-${Date.now()}`)

  const osmLink = page.getByRole('link', { name: 'Open in OpenStreetMap' })
  await expect(osmLink).toBeVisible()

  const href = await osmLink.getAttribute('href')
  expect(href).toMatch(/^https:\/\/www\.openstreetmap\.org\/\?mlat=[\d.-]+&mlon=[\d.-]+#map=\d+\//)
  expect(href).toContain('mlat=')
  expect(href).toContain('mlon=')
})

test('onboarding modal opens and closes correctly', async ({ page }) => {
  await page.goto('/')
  await waitForMapReady(page)

  // Modal should not be visible initially
  await expect(page.locator('.modal-shell')).not.toBeVisible()

  // Click "New Here?" button
  await page.getByRole('button', { name: 'New Here?' }).click()

  // Modal should open with correct content
  const modal = page.locator('.modal-shell')
  await expect(modal).toBeVisible()
  await expect(modal).toContainText('What this tool is for')
  await expect(modal).toContainText('Radius-first scouting')
  await expect(modal).toContainText('Queue and capture')
  await expect(modal).toContainText('Replay the territory')

  // All 3 onboarding cards should be visible
  await expect(modal.locator('.onboarding-card')).toHaveCount(3)

  // Close the modal
  await modal.getByRole('button', { name: 'Close' }).click()
  await expect(modal).not.toBeVisible()
})

test('user manual link is accessible', async ({ page }) => {
  await page.goto('/')
  await waitForMapReady(page)

  const manualLink = page.getByRole('link', { name: 'User Manual' })
  await expect(manualLink).toBeVisible()
  await expect(manualLink).toHaveAttribute('href', '/user-manual.html')
  await expect(manualLink).toHaveAttribute('target', '_blank')
})

test('blocks 100 mile multi-category searches and still allows a single-category beta sweep', async ({ page }) => {
  const scoutName = `smoke-e2e-100-${Date.now()}`

  await page.goto('/')
  await waitForMapReady(page)
  await createScout(page, scoutName)

  await page.getByTestId('origin-input').fill('350 5th Ave, New York, NY 10118')
  await page.getByTestId('radius-grid').getByRole('button', { name: '100 mi (beta)', exact: true }).click()
  await setCategories(page, ['hospitals', 'schools'])

  await expect(page.locator('.search-note').filter({ hasText: LARGE_RADIUS_BETA_MESSAGE })).toContainText(LARGE_RADIUS_BETA_MESSAGE)
  await expect(page.getByTestId('search-button')).toBeDisabled()

  await setCategories(page, ['hospitals'])
  await expect(page.locator('.search-note').filter({ hasText: '100 mi beta is intended for broad single-category sweeps' }))
    .toContainText('100 mi beta is intended for broad single-category sweeps')
  await expect(page.getByTestId('search-button')).toBeEnabled()

  await page.getByTestId('search-button').click()
  await expect(page.getByTestId('result-list').locator('.result-card').first()).toBeVisible({ timeout: 60_000 })
  await assertNoWorkerErrors(page)
})
