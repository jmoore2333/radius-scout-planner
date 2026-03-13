import { expect, test } from '@playwright/test'
import {
  createScout,
  queueCardByName,
  runSearch,
  waitForMapReady,
  waitForProviderCards,
} from './helpers'

test('queue filters hide photographed and skipped items by default', async ({ page }) => {
  const scoutName = `filter-e2e-${Date.now()}`

  await page.goto('/')
  await waitForMapReady(page)
  await waitForProviderCards(page)
  await createScout(page, scoutName)

  await runSearch(page, {
    origin: '100 N Queen St, Lancaster, PA 17603',
    radiusLabel: '10 mi',
    categories: ['hospitals', 'malls'],
  })

  // Queue the first result
  const firstResult = page.getByTestId('result-list').locator('.result-card').first()
  await expect(firstResult).toBeVisible({ timeout: 60_000 })
  const poiName = (await firstResult.locator('strong').textContent())?.trim() ?? ''
  await firstResult.click()
  await page.getByRole('textbox', { name: 'Why this matters' }).fill('Filter test.')
  await page.getByTestId('queue-button').click()

  const queueCard = queueCardByName(page, poiName)
  await expect(queueCard).toBeVisible({ timeout: 60_000 })

  // Verify filters are visible with counts
  const filters = page.getByTestId('queue-filters')
  await expect(filters).toBeVisible()
  await expect(filters.getByLabel(/queued/)).toBeChecked()
  await expect(filters.getByLabel(/visited/)).toBeChecked()
  await expect(filters.getByLabel(/photographed/)).not.toBeChecked()
  await expect(filters.getByLabel(/skipped/)).not.toBeChecked()

  // Card is visible as "queued" (default status, filter checked)
  await expect(queueCard).toBeVisible()

  // Mark as photographed — card should disappear from filtered list
  await queueCard.locator('select').selectOption('photographed')
  await expect(queueCard).not.toBeVisible({ timeout: 15_000 })

  // Empty state message should indicate items are hidden
  await expect(page.getByTestId('queue-list')).toContainText('hidden by filters')

  // Enable the photographed filter — card should reappear
  await filters.getByLabel(/photographed/).check()
  await expect(queueCard).toBeVisible({ timeout: 15_000 })

  // Uncheck it again — card disappears
  await filters.getByLabel(/photographed/).uncheck()
  await expect(queueCard).not.toBeVisible({ timeout: 15_000 })

  // Mark as skipped (enable photographed first so we can interact)
  await filters.getByLabel(/photographed/).check()
  await queueCard.locator('select').selectOption('skipped')
  await filters.getByLabel(/photographed/).uncheck()
  // Skipped is also hidden by default
  await expect(queueCard).not.toBeVisible({ timeout: 15_000 })

  // Enable skipped filter — card reappears
  await filters.getByLabel(/skipped/).check()
  await expect(queueCard).toBeVisible({ timeout: 15_000 })
})
