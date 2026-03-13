import { devices, expect, test } from '@playwright/test'
import { createScout, runSearch, uploadTinyImage, waitForMapReady, waitForRememberedScout } from './helpers'

test.use({ ...devices['Pixel 7'] })

test('mobile search handles broad category searches without worker errors', async ({ page }) => {
  const scoutName = `mobile-smoke-${Date.now()}`

  await page.goto('/')
  await waitForMapReady(page)
  await createScout(page, scoutName)
  await runSearch(page, {
    origin: 'Scranton, PA',
    radiusLabel: '25 mi',
    categories: ['hospitals', 'schools', 'malls', 'restaurants', 'coffee_shops', 'movie_theaters'],
  })

  await expect(page.getByTestId('result-list').locator('.result-card').first()).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('body')).not.toContainText('Too many subrequests by single Worker invocation')
  await expect(page.locator('body')).not.toContainText('Failed query:')
})

test('mobile restores queued evidence after a reload', async ({ page }) => {
  const scoutName = `mobile-story-${Date.now()}`

  await page.goto('/')
  await waitForMapReady(page)
  const scoutId = await createScout(page, scoutName)
  await runSearch(page, {
    origin: '1600 Pennsylvania Ave NW, Washington, DC 20500',
    radiusLabel: '5 mi',
    categories: ['hospitals', 'schools'],
  })

  const firstResult = page.getByTestId('result-list').locator('.result-card').first()
  const queuedPoiName = (await firstResult.locator('strong').textContent())?.trim() ?? ''
  await firstResult.click()
  await page.getByRole('textbox', { name: 'Why this matters' }).fill('Mobile persistence check for a saved scout pin.')
  await page.getByTestId('queue-button').click()

  const queueCard = page.getByTestId('queue-list').locator('.queue-card').first()
  await uploadTinyImage(queueCard.locator('input[type="file"]'))
  await expect(queueCard).toContainText('1 uploads', { timeout: 60_000 })
  await waitForRememberedScout(page, scoutId)

  await page.reload()
  await waitForMapReady(page)
  await expect.poll(() => page.getByTestId('scout-select').inputValue(), { timeout: 15_000 }).toBe(scoutId)
  await expect(page.getByRole('heading', { name: '1 saved scout pins ready for review' })).toBeVisible()
  await expect(page.locator('.gallery-card').first()).toContainText(queuedPoiName)
  await page.getByRole('button', { name: 'Show pin' }).click()
  await expect(page.getByRole('heading', { name: queuedPoiName })).toBeVisible()
})
