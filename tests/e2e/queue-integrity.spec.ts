import { expect, test } from '@playwright/test'
import {
  createScout,
  queueCardByName,
  runSearch,
  waitForMapReady,
  waitForProviderCards,
} from './helpers'

test('queue gracefully handles an orphaned POI reference injected via interception', async ({ page }) => {
  const scoutName = `integrity-e2e-${Date.now()}`

  await page.goto('/')
  await waitForMapReady(page)
  await waitForProviderCards(page)
  const scoutId = await createScout(page, scoutName)

  await runSearch(page, {
    origin: '100 N Queen St, Lancaster, PA 17603',
    radiusLabel: '10 mi',
    categories: ['hospitals', 'malls'],
  })

  // Queue two POIs from the result list
  const resultList = page.getByTestId('result-list').locator('.result-card')
  await expect(resultList.first()).toBeVisible({ timeout: 60_000 })

  const firstResult = resultList.nth(0)
  const firstPoiName = (await firstResult.locator('strong').textContent())?.trim() ?? ''
  await firstResult.click()
  await page.getByRole('textbox', { name: 'Why this matters' }).fill('Integrity test target 1.')
  await page.getByTestId('queue-button').click()
  await expect(page.getByTestId('queue-list').locator('.queue-card')).toHaveCount(1, { timeout: 60_000 })

  const secondResult = resultList.nth(1)
  const secondPoiName = (await secondResult.locator('strong').textContent())?.trim() ?? ''
  await secondResult.click()
  await page.getByRole('textbox', { name: 'Why this matters' }).fill('Integrity test target 2.')
  await page.getByTestId('queue-button').click()
  await expect(page.getByTestId('queue-list').locator('.queue-card')).toHaveCount(2, { timeout: 60_000 })

  // Both queue cards should be visible before interception
  await expect(queueCardByName(page, firstPoiName)).toBeVisible()
  await expect(queueCardByName(page, secondPoiName)).toBeVisible()

  // Intercept the queue endpoint to inject a third item with a non-existent
  // POI id. This simulates the scenario where a queue row references a POI
  // that has been deleted from the catalog.
  await page.route(`**/api/scouts/${scoutId}/queue`, async route => {
    const response = await route.fetch()
    const body = await response.json()

    const orphanedItem = {
      id: 'orphan-queue-item-id',
      status: 'queued',
      distanceMiles: 5.0,
      interestReason: 'Ghost POI that no longer exists.',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      poi: {
        id: 'non-existent-poi-id',
        providerPlaceKey: 'ghost:missing-poi',
        name: 'Phantom Location',
        category: 'hospitals',
        rawCategories: ['hospital'],
        address: '999 Nowhere St',
        lat: 40.0,
        lng: -76.0,
        distanceMiles: 5.0,
        website: null,
        phone: null,
        queueItem: null,
      },
      notes: [],
      media: [],
    }

    const patched = {
      ...body,
      queueItems: [...body.queueItems, orphanedItem],
    }

    await route.fulfill({ response, body: JSON.stringify(patched) })
  })

  // Reload to trigger a fresh queue fetch through the intercepted route
  await page.reload()
  await waitForMapReady(page)

  // The app should render all three items (including the orphaned one) without
  // crashing, since the injected item has a fully formed POI object. The
  // real-world protection lives on the backend (edge/index.ts line 625-628
  // silently skips queue rows whose POI is missing from poi_catalog), but the
  // frontend should also handle unexpected items without errors.
  await expect(page.getByTestId('queue-list').locator('.queue-card')).toHaveCount(3, { timeout: 60_000 })
  await expect(queueCardByName(page, firstPoiName)).toBeVisible()
  await expect(queueCardByName(page, secondPoiName)).toBeVisible()
  await expect(queueCardByName(page, 'Phantom Location')).toBeVisible()

  // Verify no worker errors appear
  await expect(page.locator('body')).not.toContainText('Too many subrequests by single Worker invocation')
  await expect(page.locator('body')).not.toContainText('Failed query:')
})

test('queue shows only valid items when intercepted response removes one POI', async ({ page }) => {
  const scoutName = `filter-e2e-${Date.now()}`

  await page.goto('/')
  await waitForMapReady(page)
  await waitForProviderCards(page)
  const scoutId = await createScout(page, scoutName)

  await runSearch(page, {
    origin: '100 N Queen St, Lancaster, PA 17603',
    radiusLabel: '10 mi',
    categories: ['hospitals', 'malls'],
  })

  // Queue two POIs
  const resultList = page.getByTestId('result-list').locator('.result-card')
  await expect(resultList.first()).toBeVisible({ timeout: 60_000 })

  const firstResult = resultList.nth(0)
  const firstPoiName = (await firstResult.locator('strong').textContent())?.trim() ?? ''
  await firstResult.click()
  await page.getByRole('textbox', { name: 'Why this matters' }).fill('Filter test target 1.')
  await page.getByTestId('queue-button').click()
  await expect(page.getByTestId('queue-list').locator('.queue-card')).toHaveCount(1, { timeout: 60_000 })

  const secondResult = resultList.nth(1)
  const secondPoiName = (await secondResult.locator('strong').textContent())?.trim() ?? ''
  await secondResult.click()
  await page.getByRole('textbox', { name: 'Why this matters' }).fill('Filter test target 2.')
  await page.getByTestId('queue-button').click()
  await expect(page.getByTestId('queue-list').locator('.queue-card')).toHaveCount(2, { timeout: 60_000 })

  // Intercept the queue endpoint to strip the first item from the response,
  // simulating the backend filtering out a queue item whose POI was deleted.
  await page.route(`**/api/scouts/${scoutId}/queue`, async route => {
    const response = await route.fetch()
    const body = await response.json()

    const filtered = {
      ...body,
      queueItems: body.queueItems.filter(
        (item: { poi: { name: string } }) => item.poi.name !== firstPoiName,
      ),
    }

    await route.fulfill({ response, body: JSON.stringify(filtered) })
  })

  // Reload to fetch the patched queue
  await page.reload()
  await waitForMapReady(page)

  // Only the second POI should appear — the first was stripped by the intercept
  await expect(page.getByTestId('queue-list').locator('.queue-card')).toHaveCount(1, { timeout: 60_000 })
  await expect(queueCardByName(page, secondPoiName)).toBeVisible()
  await expect(queueCardByName(page, firstPoiName)).not.toBeVisible()

  // The heading should reflect the reduced count
  await expect(page.getByRole('heading', { name: '1 saved scout pins ready for review' })).toBeVisible()

  // Verify no worker errors
  await expect(page.locator('body')).not.toContainText('Too many subrequests by single Worker invocation')
  await expect(page.locator('body')).not.toContainText('Failed query:')
})
