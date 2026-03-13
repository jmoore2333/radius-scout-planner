import { expect, type Page, test } from '@playwright/test'
import {
  waitForMapReady,
  waitForProviderCards,
} from './helpers'

function buildProviderStatuses(statuses: Record<string, unknown>[], state: string, ratio: number) {
  return statuses.map((status) => ({
    ...status,
    state,
    used: Math.round((status.limit as number) * ratio),
    ratio,
  }))
}

async function interceptProviderState(
  page: Page,
  state: string,
  ratio: number,
  lockState: Record<string, unknown>,
) {
  const handler = async (route: { fetch: () => Promise<Response>; fulfill: (opts: Record<string, unknown>) => Promise<void> }) => {
    const response = await route.fetch()
    const body = await response.json()
    const patched = {
      ...body,
      providerStatuses: buildProviderStatuses(body.providerStatuses, state, ratio),
      lockState,
    }
    await route.fulfill({ response, body: JSON.stringify(patched) })
  }

  await page.route('**/api/session', handler)
  await page.route('**/api/provider-status', handler)
}

async function clearProviderInterceptions(page: Page) {
  await page.unroute('**/api/session')
  await page.unroute('**/api/provider-status')
}

test('shows warning state on provider card when usage reaches 80%', async ({ page }) => {
  await interceptProviderState(page, 'warning', 0.8, {
    isLocked: false,
    lockedProvider: null,
    message: null,
    availableAt: null,
  })

  await page.goto('/')
  await waitForMapReady(page)
  await waitForProviderCards(page)

  // The provider cards should display the 'warning' state badge
  const warningBadge = page.locator('.provider-state-warning')
  await expect(warningBadge.first()).toBeVisible({ timeout: 15_000 })
  await expect(warningBadge.first()).toContainText('warning')

  // The workspace should NOT be in offline/locked mode
  await expect(page.locator('.offline-workspace')).not.toBeVisible()

  // The normal workspace with search controls should be available
  await expect(page.getByTestId('search-button')).toBeVisible()
})

test('shows locked offline workspace when usage reaches 90%', async ({ page }) => {
  const availableAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()

  await interceptProviderState(page, 'locked', 0.9, {
    isLocked: true,
    lockedProvider: 'azure.search',
    message: 'Azure Maps Search is offline until the billing period resets.',
    availableAt,
  })

  await page.goto('/')

  // The offline workspace with the lock panel should be visible
  const offlineWorkspace = page.locator('.offline-workspace')
  await expect(offlineWorkspace).toBeVisible({ timeout: 30_000 })

  const lockPanel = page.locator('.lock-panel')
  await expect(lockPanel).toBeVisible()

  // Verify the lock panel content
  await expect(lockPanel).toContainText('Provider safety cap reached')
  await expect(lockPanel).toContainText('Azure Maps Search is offline')
  await expect(lockPanel).toContainText('Azure Maps Search')

  // The normal workspace search button should NOT be present
  await expect(page.getByTestId('search-button')).not.toBeVisible()

  // Provider cards in the settings panel should show 'locked' state
  const lockedBadge = page.locator('.provider-state-locked')
  await expect(lockedBadge.first()).toBeVisible({ timeout: 15_000 })
})

test('recovers from locked state to normal after quota resets', async ({ page }) => {
  const availableAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()

  await interceptProviderState(page, 'locked', 0.9, {
    isLocked: true,
    lockedProvider: 'azure.search',
    message: 'Azure Maps Search is offline until the billing period resets.',
    availableAt,
  })

  await page.goto('/')
  await expect(page.locator('.offline-workspace')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.lock-panel')).toBeVisible()

  // Remove all interceptions so the next calls return the real (healthy) state
  await clearProviderInterceptions(page)

  // Reload the page to trigger a fresh /api/session call without interception
  await page.reload()
  await waitForMapReady(page)
  await waitForProviderCards(page)

  // The offline workspace should no longer be visible
  await expect(page.locator('.offline-workspace')).not.toBeVisible()

  // The normal workspace should be back
  await expect(page.getByTestId('search-button')).toBeVisible()

  // Provider cards should show 'healthy' state
  const healthyBadge = page.locator('.provider-state-healthy')
  await expect(healthyBadge.first()).toBeVisible({ timeout: 15_000 })
})
