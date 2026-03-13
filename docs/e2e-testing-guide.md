# End-to-End Testing Guide

## Overview

Radius Scout Planner uses **Playwright** with Chromium for end-to-end testing. Tests run in three modes:

- **Mock mode** (`PROVIDER_MOCKS=1`): Uses fixture data instead of real Azure Maps/Mapbox APIs. Fast, free, no quota usage. **Validates all application logic** — search workflows, queue management, uploads, exports, input validation, provider quota states, and edge cases. This is the default mode and is sufficient for verifying correctness.
- **Live mode** (`APP_BASE_URL=<url>`): Tests against a deployed Cloudflare Workers instance with real APIs. Runs the same test suite but **adds map viewport assertions** (cluster counts, zoom levels, tile rendering) that are only meaningful with real Mapbox tiles. Uses API quota — run sparingly.
- **Screenshot capture** (`CAPTURE_ONBOARDING=1` or `CAPTURE_MANUAL=1` + `APP_BASE_URL`): Captures images from a live deployment for the built-in user manual. Skipped by default. Run after deploying to generate documentation screenshots.

All tests run in a single worker (no parallelization) to avoid shared-state issues.

### WebGL in Headless Chromium

Headless Chromium lacks native WebGL. Playwright is configured with SwiftShader software rendering:

```
args: ['--use-gl=angle', '--use-angle=swiftshader']
```

This allows Mapbox GL JS to render without crashing. If you see visual artifacts, run in headed mode.

## Running Tests

```bash
# All tests (mock mode, local dev server)
npm run test:e2e

# Single file
npx playwright test tests/e2e/app.spec.ts

# Match by name
npx playwright test --grep "map center"

# Headed mode (see the browser)
PLAYWRIGHT_HEADLESS=false npx playwright test --headed

# Against a live deployment
APP_BASE_URL=https://your-url.workers.dev npx playwright test
```

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PROVIDER_MOCKS` | — | Set to `1` in `.dev.vars` for mock API responses |
| `PLAYWRIGHT_HEADLESS` | `true` | Set to `false` for headed browser |
| `APP_BASE_URL` | `http://localhost:8799` | Override with deployed URL for live mode |
| `CAPTURE_ONBOARDING` | — | Set to `1` to capture onboarding screenshots |
| `CAPTURE_MANUAL` | — | Set to `1` to capture manual screenshots |

## Test Files

### `app.spec.ts` — Core Workflows

The main smoke test covering the full user journey:

| Test | What It Covers |
|------|---------------|
| searches, queues, uploads, exports | Full workflow: search → queue POI → upload evidence → CSV/GeoJSON export → reload persistence |
| switching scout profiles | Profile isolation — queue data doesn't bleed between scouts |
| clusters + capture metadata | Dense 6-category search, EXIF GPS extraction, map focus on capture point |
| map center search (no address) | Searching with empty origin falls back to current map center |
| no scout profile selected | Error message when searching without creating a profile first |
| Use map center button | Explicit "Use map center" button sends map coordinates |
| OpenStreetMap link | OSM link renders with correct `mlat`/`mlon`/`#map` URL format |
| onboarding modal | "New Here?" modal opens, shows 3 slides, closes |
| user manual link | Link to `/user-manual.html` is visible and correct |
| 100 mi beta limit | Multi-category blocked at 100 mi; single-category allowed |

### `quota-states.spec.ts` — Provider Quota States

Tests provider budget guardrails using route interception (no real API calls):

| Test | What It Covers |
|------|---------------|
| warning at 80% | Warning badge appears, workspace remains usable |
| locked at 90% | Offline workspace with lock panel, search disabled |
| recovery after reset | Locked → reload → healthy state restored |

### `sparse-results.spec.ts` — Geographic Edge Cases

| Test | What It Covers |
|------|---------------|
| Dillon, MT | Rural area with 1-4 results — verifies sparse data renders |
| Tonopah, NV | Zero results — verifies no crash, app remains functional |
| Meridian, ID | Moderate suburban results — verifies typical data density |

### `mobile.spec.ts` — Mobile Viewport (Pixel 7)

| Test | What It Covers |
|------|---------------|
| broad category search | 6-category search on mobile without worker subrequest errors |
| reload persistence | Queue, uploads, and scout ID survive page reload on mobile |

### `upload-validation.spec.ts` — Upload Endpoint Validation

| Test | What It Covers |
|------|---------------|
| non-image file rejected | `.txt` file returns error, doesn't crash |
| empty file rejected | 0-byte file handled gracefully |
| valid image accepted | Sanity check that normal uploads work |
| multi-file upload (3 files) | Uploads 3 PNGs at once, verifies count in toast and queue card |
| mixed valid/invalid multi-upload | 1 valid PNG + 1 `.txt` — reports partial success (`1/2 uploaded`) |

### `queue-filters.spec.ts` — Queue Status Filters

| Test | What It Covers |
|------|---------------|
| filter toggle show/hide | Photographed/skipped hidden by default, toggling checkboxes shows/hides cards, empty state message when all filtered |

### `media-preview.spec.ts` — Non-Web-Renderable Image Fallback

| Test | What It Covers |
|------|---------------|
| HEIC fallback display | Route interception patches media to `image/heic` — verifies file-preview-fallback renders instead of broken `<img>` |

### `export-validation.spec.ts` — Export Endpoint Validation

| Test | What It Covers |
|------|---------------|
| CSV/GeoJSON without scoutProfileId | Returns 400 error |
| CSV/GeoJSON with empty scout | Returns 200 with headers only / empty FeatureCollection |
| CSV/GeoJSON with fake scoutProfileId | Returns 200 with empty data (no crash) |

### `queue-statuses.spec.ts` — Queue Status Transitions

| Test | What It Covers |
|------|---------------|
| full status cycle | queued → visited → photographed → skipped → queued, persists after reload |

### `note-stack.spec.ts` — Note Truncation

| Test | What It Covers |
|------|---------------|
| 4 notes, 3 displayed | Adds 4 notes, verifies UI truncates to first 3 |

### `debug-controls.spec.ts` — Debug Panel

| Test | What It Covers |
|------|---------------|
| hidden by default | Debug controls not visible in normal mode |
| visible when enabled | Route interception to enable debug, button appears |
| reset button works | Clicks reset, verifies POST to `/api/provider-debug/reset` |

### `queue-integrity.spec.ts` — Orphaned POI Handling

| Test | What It Covers |
|------|---------------|
| orphaned POI reference | Queue item with missing POI is silently dropped, no crash |
| partial POI removal | One valid + one invalid item → only valid one shown |

### Screenshot Capture Tests (skipped by default)

- `onboarding-screenshots.spec.ts` — Captures overview/queue/history images for docs
- `manual-capture.spec.ts` — Captures desktop + mobile screenshots for user manual

These require `CAPTURE_ONBOARDING=1` or `CAPTURE_MANUAL=1` and `APP_BASE_URL` to be set.

## Shared Helpers (`helpers.ts`)

| Function | Purpose |
|----------|---------|
| `waitForMapReady(page)` | Waits for map shell to render (60s timeout) |
| `createScout(page, name)` | Creates scout profile, returns ID |
| `waitForProviderCards(page)` | Waits for 2 provider status cards |
| `runSearch(page, { origin, radiusLabel, categories })` | Full search workflow + worker error check |
| `setCategories(page, keys[])` | Toggles category buttons to match selection |
| `uploadTinyImage(input)` | Uploads minimal 1x1 PNG |
| `uploadNearbyCaptureProof(input)` | Uploads GPS-tagged JPEG with EXIF metadata |
| `queueCardByName(page, name)` | Finds queue card by POI name |
| `assertNoWorkerErrors(page)` | Checks for worker subrequest/query errors |
| `readLiveMapViewport(page)` | Reads map center/zoom/clusters (live mode only) |
| `waitForRememberedScout(page, id)` | Waits for scout ID to persist in localStorage |

## Writing New Tests

```typescript
import { expect, test } from '@playwright/test'
import { waitForMapReady, createScout, runSearch } from './helpers'

test('my new test', async ({ page }) => {
  await page.goto('/')
  await waitForMapReady(page)
  const scoutId = await createScout(page, `test-${Date.now()}`)

  await runSearch(page, {
    origin: 'Lancaster, PA',
    radiusLabel: '10 mi',
    categories: ['hospitals'],
  })

  // Assert on results, queue, etc.
})
```

### Route Interception Pattern

To mock API responses without changing fixtures:

```typescript
await page.route('**/api/session', async route => {
  const response = await route.fetch()
  const body = await response.json()
  const patched = { ...body, debugControlsEnabled: true }
  await route.fulfill({ response, body: JSON.stringify(patched) })
})
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Map timeout / "map-shell not visible" | Try headed mode: `PLAYWRIGHT_HEADLESS=false npx playwright test --headed` |
| "Too many subrequests" | Reduce categories or radius in the failing test |
| Stale state / flaky results | `rm -rf .wrangler/state && npx playwright test` |
| Scout creation timeout | Check browser console in headed mode for app startup errors |
| WebGL visual artifacts | Run in headed mode or against live deployment |
| Quota state tests flaky | Ensure only one test run at a time; clear `.wrangler/state` |
| Screenshot tests skipped | Set `CAPTURE_ONBOARDING=1` or `CAPTURE_MANUAL=1` and `APP_BASE_URL` |
