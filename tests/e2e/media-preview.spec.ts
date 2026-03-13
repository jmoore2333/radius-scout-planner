import { expect, test } from '@playwright/test'
import {
  createScout,
  queueCardByName,
  runSearch,
  uploadTinyImage,
  waitForMapReady,
  waitForProviderCards,
} from './helpers'

test('non-web-renderable image shows file fallback instead of broken img tag', async ({ page }) => {
  const scoutName = `media-preview-${Date.now()}`

  await page.goto('/')
  await waitForMapReady(page)
  await waitForProviderCards(page)
  await createScout(page, scoutName)

  await runSearch(page, {
    origin: '100 N Queen St, Lancaster, PA 17603',
    radiusLabel: '10 mi',
    categories: ['hospitals'],
  })

  // Queue a POI and upload a valid image
  const firstResult = page.getByTestId('result-list').locator('.result-card').first()
  await expect(firstResult).toBeVisible({ timeout: 60_000 })
  const poiName = (await firstResult.locator('strong').textContent())?.trim() ?? ''
  await firstResult.click()
  await page.getByRole('textbox', { name: 'Why this matters' }).fill('Media preview test.')
  await page.getByTestId('queue-button').click()

  const queueCard = queueCardByName(page, poiName)
  await expect(queueCard).toBeVisible({ timeout: 60_000 })

  // Upload a valid image first
  await uploadTinyImage(queueCard.locator('input[type="file"]'))
  await expect(queueCard).toContainText('1 uploads', { timeout: 60_000 })

  // Set up route interception BEFORE reload — intercept both the collections API
  // and the session API (which triggers initial data load) to patch media contentType
  await page.route('**/api/scouts/*/queue', async route => {
    const response = await route.fetch()
    const body = await response.json()

    if (body.queueItems) {
      for (const item of body.queueItems) {
        if (item.media) {
          for (const media of item.media) {
            media.contentType = 'image/heic'
            media.fileName = 'photo.heic'
          }
        }
      }
    }

    await route.fulfill({ response, body: JSON.stringify(body) })
  })

  // Reload — the intercepted route will patch the media type during load
  await page.reload()
  await waitForMapReady(page)

  // The queue card should still be visible (status is "queued")
  const reloadedCard = queueCardByName(page, poiName)
  await expect(reloadedCard).toBeVisible({ timeout: 60_000 })

  // Click on the queue card to select the POI and see the detail panel
  await reloadedCard.click()
  await expect(page.locator('.detail-story')).toBeVisible({ timeout: 15_000 })

  // The media should show the file fallback, not a broken <img>
  const fallback = page.locator('.file-preview-fallback')
  await expect(fallback.first()).toBeVisible({ timeout: 15_000 })
  await expect(fallback.first()).toContainText('photo.heic')

  // There should be NO broken <img> tag for this media
  const mediaCard = page.locator('.media-card').first()
  await expect(mediaCard.locator('img')).not.toBeVisible()

  // "Open asset" link should still be available
  await expect(mediaCard.getByRole('link', { name: 'Open asset' })).toBeVisible()
})
