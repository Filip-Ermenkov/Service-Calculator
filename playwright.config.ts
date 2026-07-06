import { defineConfig, devices } from '@playwright/test'

/**
 * Read environment variables from file.
 * https://github.com/motdotla/dotenv
 */
import 'dotenv/config'

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: './tests/e2e',
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Opt out of parallel tests on CI. */
  workers: process.env.CI ? 1 : undefined,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: 'html',
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    // baseURL: 'http://localhost:3000',

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], channel: 'chromium' },
    },
  ],
  webServer: {
    command: 'npm run dev',
    // Playwright's own default template uses `!process.env.CI` here for a
    // reason: reusing a dev server that's already running is a nice speedup
    // locally, but it means a stale server — e.g. one started before a
    // proxy.ts/middleware change, which Next's dev server does not reliably
    // hot-reload — silently gets tested instead of the current code. That
    // exact scenario reproduced the "route isn't actually gated" failure
    // here even after the fix landed: the old server was still running.
    // Hardcoding `true` traded that safety for a speed-up this project
    // doesn't need in CI (no server is ever already running there) and
    // shouldn't rely on locally either.
    reuseExistingServer: !process.env.CI,
    url: 'http://localhost:3000',
  },
})
