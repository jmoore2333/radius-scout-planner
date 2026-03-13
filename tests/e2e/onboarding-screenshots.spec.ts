import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { createScout, runSearch, uploadNearbyCaptureProof, waitForLiveMapViewport, waitForMapReady, waitForProviderCards } from './helpers'

test.skip(!process.env.CAPTURE_ONBOARDING, 'Only run when capturing onboarding screenshots.')

const outputDir = path.join(process.cwd(), 'public', 'onboarding')

test('captures onboarding screenshots from the running app', async ({ page }) => {
  const scoutName = `docs-e2e-${Date.now()}`
  await fs.mkdir(outputDir, { recursive: true })

  await page.goto('/')
  await waitForMapReady(page)
  await waitForProviderCards(page)
  await waitForLiveMapViewport(page)
  await createScout(page, scoutName)
  await runSearch(page, {
    origin: '350 5th Ave, New York, NY 10118',
    radiusLabel: '10 mi',
    categories: ['hospitals', 'schools', 'malls', 'restaurants', 'coffee_shops', 'movie_theaters'],
  })
  await waitForLiveMapViewport(page)

  await page.screenshot({ path: path.join(outputDir, 'overview.jpg'), type: 'jpeg', quality: 82 })

  const amcResult = page.getByTestId('result-list').getByRole('button', { name: /AMC 34th Street 14/i }).first()
  await amcResult.click()
  await page.getByRole('textbox', { name: 'Why this matters' }).fill('Onboarding capture workflow for a clustered live-map point.')
  await page.getByRole('textbox', { name: 'Field note' }).fill('Upload a nearby GPS-tagged proof image and show the capture point on the live map.')
  await page.getByTestId('queue-button').click()
  const queueCard = page.getByTestId('queue-list').locator('.queue-card').filter({ hasText: 'AMC 34th Street 14' }).first()
  await expect(queueCard).toBeVisible({ timeout: 60_000 })
  await uploadNearbyCaptureProof(queueCard.locator('input[type="file"]'))
  await expect(queueCard).toContainText('1 uploads', { timeout: 60_000 })
  await page.getByRole('combobox', { name: 'Queue status' }).selectOption('photographed')
  await page.getByTestId('queue-button').click()
  await expect(page.locator('.detail-story')).toContainText('DJI Mini 4 Pro', { timeout: 60_000 })

  const selectedPointPanel = page.locator('.detail-story')
  await selectedPointPanel.screenshot({ path: path.join(outputDir, 'queue.jpg'), type: 'jpeg', quality: 82 })

  await page.reload()
  await waitForMapReady(page)
  await waitForProviderCards(page)
  await waitForLiveMapViewport(page)
  await expect(page.getByRole('heading', { name: '1 saved scout pins ready for review' })).toBeVisible({ timeout: 60_000 })
  await page.screenshot({ path: path.join(outputDir, 'history.jpg'), type: 'jpeg', quality: 82 })
})
