import fs from 'node:fs/promises'
import path from 'node:path'
import { devices, expect, test } from '@playwright/test'
import {
  createScout,
  queueCardByName,
  runSearch,
  uploadNearbyCaptureProof,
  waitForLiveMapViewport,
  waitForMapReady,
  waitForProviderCards,
} from './helpers'

test.skip(!process.env.CAPTURE_MANUAL, 'Only run when capturing manual screenshots.')

const desktopDir = path.join(process.cwd(), 'public', 'manual', 'desktop')
const mobileDir = path.join(process.cwd(), 'public', 'manual', 'mobile')
const onboardingDir = path.join(process.cwd(), 'public', 'onboarding')

test('captures desktop manual screenshots from the deployed app', async ({ page }) => {
  const scoutName = `manual-desktop-${Date.now()}`

  await fs.mkdir(desktopDir, { recursive: true })
  await fs.mkdir(onboardingDir, { recursive: true })

  await page.goto('/')
  await waitForMapReady(page)
  await waitForProviderCards(page)
  await waitForLiveMapViewport(page)

  await page.screenshot({ path: path.join(desktopDir, '01-desktop-home-mapbox.jpg'), type: 'jpeg', quality: 82 })
  await page.locator('.panel').filter({ hasText: 'Provider budget guardrails' }).first()
    .screenshot({ path: path.join(desktopDir, '05-desktop-settings-mapbox.jpg'), type: 'jpeg', quality: 82 })

  await createScout(page, scoutName)
  await runSearch(page, {
    origin: '350 5th Ave, New York, NY 10118',
    radiusLabel: '10 mi',
    categories: ['hospitals', 'schools', 'malls', 'restaurants', 'coffee_shops', 'movie_theaters'],
  })
  await waitForLiveMapViewport(page)

  await page.screenshot({ path: path.join(desktopDir, '02-desktop-search-mapbox.jpg'), type: 'jpeg', quality: 82 })
  await page.screenshot({ path: path.join(onboardingDir, 'overview.jpg'), type: 'jpeg', quality: 82 })

  const amcResult = page.getByTestId('result-list').getByRole('button', { name: /AMC 34th Street 14/i }).first()
  await expect(amcResult).toBeVisible({ timeout: 60_000 })
  await amcResult.click()
  await page.getByRole('textbox', { name: 'Why this matters' }).fill(
    'Times Square-adjacent theater frontage with marquee light, rooftop context, and dense-block navigation concerns.',
  )
  await page.getByRole('textbox', { name: 'Field note' }).fill(
    'Use the uploaded JPEG to confirm the capture metadata, then jump back to the capture point on the map.',
  )
  await page.getByTestId('queue-button').click()

  const queueCard = queueCardByName(page, 'AMC 34th Street 14')
  await expect(queueCard).toBeVisible({ timeout: 60_000 })
  await uploadNearbyCaptureProof(queueCard.locator('input[type="file"]'))
  await expect(page.locator('.detail-story')).toContainText('DJI Mini 4 Pro', { timeout: 60_000 })
  await page.getByRole('combobox', { name: 'Queue status' }).selectOption('photographed')
  await page.getByTestId('queue-button').click()

  await page.screenshot({ path: path.join(desktopDir, '03-desktop-queue-metadata-mapbox.jpg'), type: 'jpeg', quality: 82 })
  await page.locator('.detail-story').screenshot({ path: path.join(onboardingDir, 'queue.jpg'), type: 'jpeg', quality: 82 })

  await page.getByRole('button', { name: 'Show capture' }).first().click()
  await waitForLiveMapViewport(page)
  await page.screenshot({ path: path.join(desktopDir, '06-desktop-capture-focus-mapbox.jpg'), type: 'jpeg', quality: 82 })

  await page.reload()
  await waitForMapReady(page)
  await waitForProviderCards(page)
  await waitForLiveMapViewport(page)
  await expect(page.getByRole('heading', { name: '1 saved scout pins ready for review' })).toBeVisible({ timeout: 60_000 })

  await page.screenshot({ path: path.join(desktopDir, '04-desktop-restored-gallery-mapbox.jpg'), type: 'jpeg', quality: 82 })
  await page.screenshot({ path: path.join(onboardingDir, 'history.jpg'), type: 'jpeg', quality: 82 })
})

test('captures mobile manual screenshots from the deployed app', async ({ browser }) => {
  const scoutName = `manual-mobile-${Date.now()}`
  const context = await browser.newContext({
    ...devices['Pixel 7'],
  })
  const page = await context.newPage()

  await fs.mkdir(mobileDir, { recursive: true })

  await page.goto('/')
  await waitForMapReady(page)
  await waitForProviderCards(page)
  await waitForLiveMapViewport(page)
  await page.screenshot({ path: path.join(mobileDir, '01-mobile-home-mapbox.jpg'), type: 'jpeg', quality: 82 })

  await createScout(page, scoutName)
  await runSearch(page, {
    origin: '1600 Pennsylvania Ave NW, Washington, DC 20500',
    radiusLabel: '5 mi',
    categories: ['hospitals', 'schools'],
  })
  await waitForLiveMapViewport(page)
  await page.screenshot({ path: path.join(mobileDir, '02-mobile-search-mapbox.jpg'), type: 'jpeg', quality: 82 })

  const firstResult = page.getByTestId('result-list').locator('.result-card').first()
  const queuedPoiName = (await firstResult.locator('strong').textContent())?.trim() ?? ''
  await firstResult.click()
  await page.getByRole('textbox', { name: 'Why this matters' }).fill('Mobile queue flow validation for a saved scouting pin.')
  await page.getByRole('textbox', { name: 'Field note' }).fill('Confirm the queue, history, and saved evidence survive a fresh session.')
  await page.getByTestId('queue-button').click()
  await expect(queueCardByName(page, queuedPoiName)).toBeVisible({ timeout: 60_000 })
  await page.screenshot({ path: path.join(mobileDir, '03-mobile-queued-mapbox.jpg'), type: 'jpeg', quality: 82 })

  await page.reload()
  await waitForMapReady(page)
  await waitForProviderCards(page)
  await waitForLiveMapViewport(page)
  await expect(page.getByRole('heading', { name: '1 saved scout pins ready for review' })).toBeVisible({ timeout: 60_000 })
  await page.screenshot({ path: path.join(mobileDir, '04-mobile-restored-mapbox.jpg'), type: 'jpeg', quality: 82 })

  await context.close()
})
