import { expect, test } from '@playwright/test'
import {
  createScout,
  queueCardByName,
  runSearch,
  waitForMapReady,
  waitForProviderCards,
} from './helpers'

test('cycles through all four queue statuses and persists after reload', async ({ page }) => {
  const scoutName = `status-e2e-${Date.now()}`

  await page.goto('/')
  await waitForMapReady(page)
  await waitForProviderCards(page)
  await createScout(page, scoutName)

  await runSearch(page, {
    origin: '100 N Queen St, Lancaster, PA 17603',
    radiusLabel: '10 mi',
    categories: ['hospitals', 'malls'],
  })

  // Queue a POI from the result list
  const firstResult = page.getByTestId('result-list').locator('.result-card').first()
  await expect(firstResult).toBeVisible({ timeout: 60_000 })
  const queuedPoiName = (await firstResult.locator('strong').textContent())?.trim() ?? ''
  await firstResult.click()
  await page.getByRole('textbox', { name: 'Why this matters' }).fill('Status transition test target.')
  await page.getByTestId('queue-button').click()

  const queueCard = queueCardByName(page, queuedPoiName)
  await expect(queueCard).toBeVisible({ timeout: 60_000 })

  // Enable all status filters so cards stay visible during transitions
  await page.getByTestId('queue-filters').getByLabel(/photographed/).check()
  await page.getByTestId('queue-filters').getByLabel(/skipped/).check()

  // Verify initial status is 'queued'
  await expect(queueCard.locator('select')).toHaveValue('queued')

  // Transition: queued -> visited
  await queueCard.locator('select').selectOption('visited')
  await expect(queueCard.locator('select')).toHaveValue('visited', { timeout: 15_000 })

  // Transition: visited -> photographed
  await queueCard.locator('select').selectOption('photographed')
  await expect(queueCard.locator('select')).toHaveValue('photographed', { timeout: 15_000 })

  // Transition: photographed -> skipped
  await queueCard.locator('select').selectOption('skipped')
  await expect(queueCard.locator('select')).toHaveValue('skipped', { timeout: 15_000 })

  // Round-trip: skipped -> queued
  await queueCard.locator('select').selectOption('queued')
  await expect(queueCard.locator('select')).toHaveValue('queued', { timeout: 15_000 })

  // Settle on 'visited' before reload to verify persistence of a non-default status
  await queueCard.locator('select').selectOption('visited')
  await expect(queueCard.locator('select')).toHaveValue('visited', { timeout: 15_000 })

  // Reload and verify the status persisted
  await page.reload()
  await waitForMapReady(page)
  const reloadedCard = queueCardByName(page, queuedPoiName)
  await expect(reloadedCard).toBeVisible({ timeout: 60_000 })
  await expect(reloadedCard.locator('select')).toHaveValue('visited', { timeout: 15_000 })
})
