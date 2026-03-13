import { expect, test } from '@playwright/test'
import {
  assertNoWorkerErrors,
  createScout,
  runSearch,
  setCategories,
  waitForMapReady,
  waitForProviderCards,
} from './helpers'

test('renders sparse results for a rural area without errors (Dillon, MT)', async ({ page }) => {
  const scoutName = `sparse-rural-${Date.now()}`

  await page.goto('/')
  await waitForMapReady(page)
  await waitForProviderCards(page)
  const scoutId = await createScout(page, scoutName)

  // Dillon, MT fixture has only 2 points: a hospital and a restaurant.
  // Use hospitals + restaurants to ensure both show up.
  await runSearch(page, {
    origin: 'Dillon, MT',
    radiusLabel: '10 mi',
    categories: ['hospitals', 'restaurants'],
  })

  const resultCards = page.getByTestId('result-list').locator('.result-card')
  const count = await resultCards.count()
  expect(count).toBeGreaterThanOrEqual(1)
  expect(count).toBeLessThanOrEqual(4) // sparse — just a few results

  // Verify the Barrett Hospital result is present
  await expect(resultCards.filter({ hasText: 'Barrett Hospital' }).first()).toBeVisible()

  // Queue the first result and verify queue works with sparse data
  const firstResult = resultCards.first()
  await firstResult.click()
  await page.getByTestId('queue-button').click()
  await expect(page.getByTestId('queue-list').locator('.queue-card')).toHaveCount(1, { timeout: 60_000 })

  await assertNoWorkerErrors(page)
})

test('handles zero results gracefully without crashing (Tonopah, NV)', async ({ page }) => {
  const scoutName = `sparse-empty-${Date.now()}`

  await page.goto('/')
  await waitForMapReady(page)
  await waitForProviderCards(page)
  await createScout(page, scoutName)

  // Tonopah, NV fixture has zero points. Do NOT use runSearch() because it
  // waits for .result-card elements which will never appear.
  await page.getByTestId('origin-input').fill('Tonopah, NV')
  await page.getByTestId('radius-grid').getByRole('button', { name: '10 mi', exact: true }).click()
  await setCategories(page, ['hospitals', 'malls'])
  await page.getByTestId('search-button').click()

  // Wait for the search to complete. With zero results, the result list should
  // be empty or show an empty state. Give the app time to process.
  await page.waitForTimeout(3_000)

  // Verify no crash — no JS errors from the worker
  await assertNoWorkerErrors(page)

  // Verify the result list has no result cards
  await expect(page.getByTestId('result-list').locator('.result-card')).toHaveCount(0)

  // Verify user can search again — the search button should still be enabled
  await expect(page.getByTestId('search-button')).toBeEnabled()

  // Run a second search to confirm the app remains functional
  await page.getByTestId('origin-input').fill('Dillon, MT')
  await setCategories(page, ['hospitals', 'restaurants'])
  await page.getByTestId('search-button').click()
  await expect(page.getByTestId('result-list').locator('.result-card').first()).toBeVisible({ timeout: 60_000 })
  await assertNoWorkerErrors(page)
})

test('renders moderate suburban results with map (Meridian, ID)', async ({ page }) => {
  const scoutName = `sparse-suburban-${Date.now()}`

  await page.goto('/')
  await waitForMapReady(page)
  await waitForProviderCards(page)
  await createScout(page, scoutName)

  // Meridian, ID fixture has 9 points across multiple categories.
  await runSearch(page, {
    origin: 'Meridian, ID',
    radiusLabel: '10 mi',
    categories: ['hospitals', 'restaurants', 'coffee_shops', 'malls'],
  })

  const resultCards = page.getByTestId('result-list').locator('.result-card')
  const count = await resultCards.count()
  expect(count).toBeGreaterThanOrEqual(3)

  // Verify specific results from the fixture
  await expect(resultCards.filter({ hasText: 'St. Luke' }).first()).toBeVisible()
  await expect(resultCards.filter({ hasText: 'Barbacoa' }).first()).toBeVisible()

  // Verify the map shell rendered without errors
  await waitForMapReady(page)
  await assertNoWorkerErrors(page)
})
