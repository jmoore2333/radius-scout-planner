import { expect, test } from '@playwright/test'
import {
  createScout,
  queueCardByName,
  runSearch,
  uploadTinyImage,
  waitForMapReady,
  waitForProviderCards,
} from './helpers'

const TINY_TXT = {
  name: 'notes.txt',
  mimeType: 'text/plain',
  buffer: Buffer.from('hello world'),
}

const EMPTY_PNG = {
  name: 'empty.png',
  mimeType: 'image/png',
  buffer: Buffer.alloc(0),
}

async function setupQueueItem(page: import('@playwright/test').Page) {
  const scoutName = `upload-val-${Date.now()}`

  await page.goto('/')
  await waitForMapReady(page)
  await waitForProviderCards(page)
  await createScout(page, scoutName)

  await runSearch(page, {
    origin: '100 N Queen St, Lancaster, PA 17603',
    radiusLabel: '10 mi',
    categories: ['hospitals'],
  })

  const firstResult = page.getByTestId('result-list').locator('.result-card').first()
  await expect(firstResult).toBeVisible({ timeout: 60_000 })
  const poiName = (await firstResult.locator('strong').textContent())?.trim() ?? ''
  await firstResult.click()

  await page.getByRole('textbox', { name: 'Why this matters' }).fill('Upload validation test target.')
  await page.getByTestId('queue-button').click()

  const queueCard = queueCardByName(page, poiName)
  await expect(queueCard).toBeVisible({ timeout: 60_000 })

  return { queueCard, poiName }
}

test('rejects non-image/non-video file upload with a graceful error', async ({ page }) => {
  const { queueCard } = await setupQueueItem(page)

  const fileInput = queueCard.locator('input[type="file"]')
  await fileInput.setInputFiles(TINY_TXT)

  await expect(page.locator('.toast')).toContainText('Only image and video uploads are supported.', {
    timeout: 15_000,
  })

  // Upload count should remain at 0 — the file was rejected
  await expect(queueCard).toContainText('0 uploads')
})

test('rejects empty (0 byte) file upload with a graceful error', async ({ page }) => {
  const { queueCard } = await setupQueueItem(page)

  const fileInput = queueCard.locator('input[type="file"]')
  await fileInput.setInputFiles(EMPTY_PNG)

  // Server should reject — either the empty file is not recognized as a valid File,
  // or the 0-byte check fires. Either way the toast should show an error.
  await expect(page.locator('.toast')).toBeVisible({ timeout: 15_000 })

  // Upload count should remain at 0
  await expect(queueCard).toContainText('0 uploads')
})

test('accepts a valid image upload (sanity check)', async ({ page }) => {
  const { queueCard } = await setupQueueItem(page)

  const fileInput = queueCard.locator('input[type="file"]')
  await uploadTinyImage(fileInput)

  await expect(queueCard).toContainText('1 uploads', { timeout: 60_000 })
})

test('uploads multiple files at once and reports count', async ({ page }) => {
  const { queueCard, poiName } = await setupQueueItem(page)

  // Create 3 minimal valid PNGs
  const PNG_HEADER = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
    0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
    0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc, 0x33, 0x00, 0x00, 0x00,
    0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ])

  const fileInput = queueCard.locator('input[type="file"]')
  await fileInput.setInputFiles([
    { name: 'photo1.png', mimeType: 'image/png', buffer: PNG_HEADER },
    { name: 'photo2.png', mimeType: 'image/png', buffer: PNG_HEADER },
    { name: 'photo3.png', mimeType: 'image/png', buffer: PNG_HEADER },
  ])

  await expect(page.locator('.toast')).toContainText('3 files uploaded', { timeout: 60_000 })
  await expect(queueCard).toContainText('3 uploads', { timeout: 60_000 })
})

test('multi-upload with mixed valid and invalid files reports partial success', async ({ page }) => {
  const { queueCard } = await setupQueueItem(page)

  const PNG_HEADER = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
    0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
    0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc, 0x33, 0x00, 0x00, 0x00,
    0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ])

  const fileInput = queueCard.locator('input[type="file"]')
  await fileInput.setInputFiles([
    { name: 'valid.png', mimeType: 'image/png', buffer: PNG_HEADER },
    { name: 'bad.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image') },
  ])

  // Should report partial success — 1 succeeded, 1 failed
  await expect(page.locator('.toast')).toContainText('1/2 uploaded', { timeout: 60_000 })
  await expect(queueCard).toContainText('1 uploads', { timeout: 60_000 })
})
