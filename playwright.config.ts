import { defineConfig } from '@playwright/test'

const baseURL = process.env.APP_BASE_URL ?? 'http://localhost:8799'
const isLive = Boolean(process.env.APP_BASE_URL)

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  use: {
    baseURL,
    headless: process.env.PLAYWRIGHT_HEADLESS === 'false' ? false : true,
    viewport: { width: 1440, height: 1200 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    launchOptions: {
      args: ['--use-gl=angle', '--use-angle=swiftshader'],
    },
  },
  webServer: isLive
    ? undefined
    : {
        command:
          'lsof -ti tcp:8799 | xargs kill -9 2>/dev/null || true && rm -rf .wrangler/state && npm run build && npx wrangler d1 migrations apply radius-scout-db --local && npx wrangler dev --port 8799 --local-protocol=http --var PROVIDER_MOCKS:1 --var APP_ENV:development',
        url: baseURL,
        reuseExistingServer: false,
        timeout: 180_000,
      },
})
