import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, type Locator, type Page } from '@playwright/test'
import { CATEGORY_DEFINITIONS, HUNDRED_MILE_BETA_LIMIT_MESSAGE } from '../../shared/constants'

const TINY_PNG = {
  name: 'field-shot.png',
  mimeType: 'image/png',
  buffer: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/axu2ikAAAAASUVORK5CYII=',
    'base64',
  ),
}
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const NEARBY_CAPTURE_PROOF = path.join(__dirname, '../fixtures/nearby-capture-proof.jpg')

export const LARGE_RADIUS_BETA_MESSAGE = HUNDRED_MILE_BETA_LIMIT_MESSAGE

export async function waitForMapReady(page: Page) {
  if (process.env.APP_BASE_URL) {
    await expect(page.getByRole('region', { name: 'Map' })).toBeVisible({ timeout: 60_000 })
    return
  }

  await expect(page.getByTestId('map-shell')).toBeVisible({ timeout: 60_000 })
}

export async function createScout(page: Page, scoutName: string) {
  await page.getByTestId('new-scout-input').fill(scoutName)
  await page.getByRole('button', { name: 'Create scout' }).click()
  await expect
    .poll(
      () =>
        page.getByTestId('scout-select').evaluate(select => {
          const element = select as HTMLSelectElement
          return element.options[element.selectedIndex]?.textContent ?? ''
        }),
      { timeout: 15_000 },
    )
    .toBe(scoutName)

  return await page.getByTestId('scout-select').inputValue()
}

export async function waitForProviderCards(page: Page, count = 2) {
  await expect(page.locator('.provider-card')).toHaveCount(count, { timeout: 60_000 })
}

export async function readLiveMapViewport(page: Page) {
  return page.evaluate(() => {
    const map = (window as Window & { __RADIUS_SCOUT_MAP__?: {
      getCenter: () => { lat: number; lng: number }
      getZoom: () => number
      querySourceFeatures: (sourceId: string) => Array<{ properties?: Record<string, unknown> }>
    } }).__RADIUS_SCOUT_MAP__

    if (!map) {
      return null
    }

    const center = map.getCenter()
    const clusterCount = map
      .querySourceFeatures('pois')
      .filter(feature => Boolean(feature.properties?.cluster)).length

    return {
      lat: center.lat,
      lng: center.lng,
      zoom: map.getZoom(),
      clusterCount,
    }
  })
}

export async function waitForLiveMapViewport(page: Page) {
  if (!process.env.APP_BASE_URL) {
    return null
  }

  await expect
    .poll(async () => readLiveMapViewport(page), {
      timeout: 60_000,
    })
    .not.toBeNull()

  return readLiveMapViewport(page)
}

export async function waitForRememberedScout(page: Page, scoutId: string) {
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('radius-scout:last-scout-id')), {
      timeout: 15_000,
    })
    .toBe(scoutId)
}

export async function setCategories(page: Page, selectedKeys: string[]) {
  for (const category of CATEGORY_DEFINITIONS) {
    const button = page.getByTestId(`category-${category.key}`)
    const isSelected = (await button.getAttribute('aria-pressed')) === 'true'
    const shouldBeSelected = selectedKeys.includes(category.key)

    if (isSelected !== shouldBeSelected) {
      await button.click()
    }

    await expect(button).toHaveAttribute('aria-pressed', shouldBeSelected ? 'true' : 'false')
  }
}

export async function runSearch(
  page: Page,
  options: {
    origin: string
    radiusLabel: string
    categories: string[]
  },
) {
  await page.getByTestId('origin-input').fill(options.origin)
  await page.getByTestId('radius-grid').getByRole('button', { name: options.radiusLabel, exact: true }).click()
  await setCategories(page, options.categories)
  await page.getByTestId('search-button').click()
  await expect(page.getByTestId('result-list').locator('.result-card').first()).toBeVisible({ timeout: 60_000 })
  await assertNoWorkerErrors(page)
}

export async function uploadTinyImage(input: Locator) {
  await input.setInputFiles(TINY_PNG)
}

export async function uploadNearbyCaptureProof(input: Locator) {
  await input.setInputFiles(NEARBY_CAPTURE_PROOF)
}

export async function assertNoWorkerErrors(page: Page) {
  await expect(page.locator('body')).not.toContainText('Too many subrequests by single Worker invocation')
  await expect(page.locator('body')).not.toContainText('Failed query:')
}

export function queueCardByName(page: Page, name: string) {
  return page.getByTestId('queue-list').locator('.queue-card').filter({ hasText: name }).first()
}
