import { expect, test } from '@playwright/test'
import {
  waitForMapReady,
  waitForProviderCards,
} from './helpers'

test('debug controls are hidden when session reports debugControlsEnabled false', async ({ page }) => {
  // In mock mode, debug controls are enabled by default. Intercept the session
  // response to force them off so we can verify the UI hides them.
  await page.route('**/api/session', async route => {
    const response = await route.fetch()
    const body = await response.json()
    const patched = { ...body, debugControlsEnabled: false }
    await route.fulfill({ response, body: JSON.stringify(patched) })
  })

  await page.goto('/')
  await waitForMapReady(page)
  await waitForProviderCards(page)

  // The provider budget panel should be visible (it always renders)
  await expect(page.locator('text=Provider budget guardrails').first()).toBeVisible()

  // But the debug controls section should not appear
  await expect(page.locator('.settings-debug')).not.toBeVisible()
  await expect(page.getByRole('button', { name: 'Reset provider debug state' })).not.toBeVisible()
})

test('debug controls are visible when session reports debugControlsEnabled true', async ({ page }) => {
  // In mock mode (PROVIDER_MOCKS=1), canUseDebugControls returns true, so the
  // session endpoint already sends debugControlsEnabled: true. Intercept to be
  // explicit and guard against implementation changes.
  await page.route('**/api/session', async route => {
    const response = await route.fetch()
    const body = await response.json()
    const patched = { ...body, debugControlsEnabled: true }
    await route.fulfill({ response, body: JSON.stringify(patched) })
  })

  await page.goto('/')
  await waitForMapReady(page)
  await waitForProviderCards(page)

  // The debug controls section should be visible in the settings panel
  await expect(page.locator('.settings-debug')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('button', { name: 'Reset provider debug state' })).toBeVisible()
  await expect(page.locator('.settings-debug')).toContainText('Debug controls are enabled for this session')
})

test('reset button posts to provider-debug/reset and shows confirmation toast', async ({ page }) => {
  await page.route('**/api/session', async route => {
    const response = await route.fetch()
    const body = await response.json()
    const patched = { ...body, debugControlsEnabled: true }
    await route.fulfill({ response, body: JSON.stringify(patched) })
  })

  await page.goto('/')
  await waitForMapReady(page)
  await waitForProviderCards(page)

  const resetButton = page.getByRole('button', { name: 'Reset provider debug state' })
  await expect(resetButton).toBeVisible({ timeout: 15_000 })

  // Listen for the reset API call before clicking
  const resetRequestPromise = page.waitForRequest(
    request =>
      request.url().includes('/api/provider-debug/reset') && request.method() === 'POST',
  )

  await resetButton.click()

  // Verify the POST request was made
  const resetRequest = await resetRequestPromise
  expect(resetRequest.method()).toBe('POST')

  // Verify the confirmation toast appears
  const toast = page.locator('.toast[role="status"]')
  await expect(toast).toBeVisible({ timeout: 15_000 })
  await expect(toast).toContainText('Provider quota state reset for this environment')
})
