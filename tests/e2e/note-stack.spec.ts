import { expect, test } from '@playwright/test'
import {
  createScout,
  queueCardByName,
  runSearch,
  waitForMapReady,
  waitForProviderCards,
} from './helpers'

test('adds multiple notes and truncates display to three', async ({ page }) => {
  const scoutName = `notes-e2e-${Date.now()}`

  await page.goto('/')
  await waitForMapReady(page)
  await waitForProviderCards(page)
  await createScout(page, scoutName)

  await runSearch(page, {
    origin: '100 N Queen St, Lancaster, PA 17603',
    radiusLabel: '10 mi',
    categories: ['hospitals', 'malls'],
  })

  // Queue a POI with an initial note
  const firstResult = page.getByTestId('result-list').locator('.result-card').first()
  await expect(firstResult).toBeVisible({ timeout: 60_000 })
  const queuedPoiName = (await firstResult.locator('strong').textContent())?.trim() ?? ''
  await firstResult.click()
  await page.getByRole('textbox', { name: 'Why this matters' }).fill('Note stacking test.')
  await page.getByRole('textbox', { name: 'Field note' }).fill('Note number one')
  await page.getByTestId('queue-button').click()

  const queueCard = queueCardByName(page, queuedPoiName)
  await expect(queueCard).toBeVisible({ timeout: 60_000 })

  // The detail panel should show the first note
  const noteStack = page.locator('.detail-story .note-stack')
  await expect(noteStack.locator('.note-card')).toHaveCount(1, { timeout: 15_000 })
  await expect(noteStack.locator('.note-card').first()).toContainText('Note number one')

  // Add note 2: fill the field note textarea and click Update
  await page.getByRole('textbox', { name: 'Field note' }).fill('Note number two')
  await page.getByTestId('queue-button').click()
  await expect(noteStack.locator('.note-card')).toHaveCount(2, { timeout: 15_000 })
  await expect(noteStack).toContainText('Note number two')

  // Add note 3
  await page.getByRole('textbox', { name: 'Field note' }).fill('Note number three')
  await page.getByTestId('queue-button').click()
  await expect(noteStack.locator('.note-card')).toHaveCount(3, { timeout: 15_000 })
  await expect(noteStack).toContainText('Note number three')

  // Add note 4 — the UI should still only show 3 notes (slice(0, 3) truncation)
  await page.getByRole('textbox', { name: 'Field note' }).fill('Note number four')
  await page.getByTestId('queue-button').click()

  // Wait for the update to complete, then verify truncation
  // The queue card meta should show "4 notes" even though only 3 are rendered
  await expect(queueCard).toContainText('4 notes', { timeout: 15_000 })
  await expect(noteStack.locator('.note-card')).toHaveCount(3, { timeout: 15_000 })
})
