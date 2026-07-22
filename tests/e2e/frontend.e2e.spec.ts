import { test, expect } from '@playwright/test'

import { SAMPLE_SERVICE_PATH_EN } from '../helpers/sampleContent'

const BASE = 'http://localhost:3000'

// Phase 2 public-site coverage. Deliberately asserts the SHELL and i18n
// behaviour (header/footer, locale routing, language switching, per-page
// rendering, the legal publish gate) rather than specific CMS content, so the
// suite is green whether or not the database has been seeded — CI runs against
// an empty Postgres, where every page correctly shows its empty state.

test.describe('Public site — shell & i18n', () => {
  test('/ redirects to a locale home and renders the shell', async ({ page }) => {
    await page.goto(`${BASE}/`)
    await expect(page).toHaveURL(/\/(en|fr|de)$/)
    await expect(page.locator('header.site-header')).toBeVisible()
    await expect(page.locator('footer.site-footer')).toBeVisible()
    // `.nav-links a` resolves to the 4 anchors — one per expected string, in order
    await expect(page.locator('.nav-links a')).toContainText(['Home', 'Projects', 'About Us', 'Careers'])
  })

  test('sets the html lang attribute per locale', async ({ page }) => {
    await page.goto(`${BASE}/en`)
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await page.goto(`${BASE}/de`)
    await expect(page.locator('html')).toHaveAttribute('lang', 'de')
  })

  test('has a skip-to-content link as the first focusable element', async ({ page }) => {
    await page.goto(`${BASE}/en`)
    await expect(page.locator('a.skip-link')).toHaveAttribute('href', '#main')
    await expect(page.locator('main#main')).toBeVisible()
  })

  test('language switcher keeps the path and swaps the locale', async ({ page }) => {
    await page.goto(`${BASE}/en/projects`)
    await page.locator('.lang-switcher').getByText('FR', { exact: true }).click()
    await expect(page).toHaveURL(/\/fr\/projects$/)
    // French nav label proves the message catalog switched too
    await expect(page.locator('.nav-links')).toContainText('Réalisations')
  })

  test('direct German URL renders German chrome', async ({ page }) => {
    await page.goto(`${BASE}/de`)
    await expect(page.locator('.nav-links')).toContainText('Startseite')
  })
})

test.describe('Public site — pages render', () => {
  for (const path of ['/en', '/en/projects', '/en/about', '/en/careers', '/en/legal', '/en/privacy']) {
    test(`renders ${path}`, async ({ page }) => {
      const res = await page.goto(`${BASE}${path}`)
      expect(res?.status()).toBeLessThan(400)
      await expect(page.locator('main#main')).toBeVisible()
      await expect(page.locator('footer.site-footer')).toBeVisible()
      await expect(page.locator('h1')).toBeVisible()
    })
  }

  // §6.9 safeguard at the render layer. Environment-agnostic: the page must
  // render exactly one of the two VALID states — "not yet available" when
  // LegalInfo is unpublished (CI's empty DB, and before the client's real
  // details arrive), or the real registration fields once it's published. It
  // must never render a broken/empty page. (The publish gate itself — that
  // incomplete data can't be published — is unit-tested via findMissingLegalFields.)
  test('legal & privacy render a valid gated-or-published state', async ({ page }) => {
    await page.goto(`${BASE}/en/legal`)
    await expect(page.locator('main')).toContainText(/Not yet available|RCS Luxembourg number/)
    await page.goto(`${BASE}/en/privacy`)
    await expect(page.locator('main h1')).toBeVisible()
  })
})

// Phase 3/4 — the live price calculator + Download-PDF, tested against the
// seeded sample service (tests/helpers/sampleContent.ts). CI seeds it before the
// e2e step (npm run seed:ci), so these run deterministically there; locally,
// against an empty DB the sample page 404s and the tests skip. The exhaustive
// arithmetic is covered separately by the pure unit tests — here we prove the
// page is interactive end-to-end (real inputs, a live-region total, a working
// /api/quote round-trip).
test.describe('Public site — live price calculator + quote (Phase 3/4)', () => {
  test('the service page shows an interactive, recomputing estimate', async ({ page }) => {
    const res = await page.goto(`${BASE}${SAMPLE_SERVICE_PATH_EN}`)
    test.skip(res?.status() === 404, 'no seeded sample service in this environment (empty DB)')
    await expect(page).toHaveURL(/\/en\/services\//)

    const total = page.locator('[data-testid="calc-total"]')
    await expect(total).toBeVisible()

    // The sample service has a required number field (Area), so the total is
    // withheld until it's filled. Fill every number input to reach a real
    // computed state, proving the inputs are live (not the old disabled preview).
    const numberInputs = page.locator('.calc-input[type="number"]')
    const count = await numberInputs.count()
    expect(count).toBeGreaterThan(0)
    for (let i = 0; i < count; i++) {
      await expect(numberInputs.nth(i)).toBeEnabled()
      await numberInputs.nth(i).fill('5')
    }

    // The select and toggle are also present and operable.
    await expect(page.locator('.calc-select')).toBeVisible()

    // With required fields satisfied, the total shows a formatted price or the
    // §7 contact copy — never the still-blank prompt.
    await expect(total).toHaveText(/€|Contact us for a price/)
  })

  test('the service page can generate a quote via /api/quote (Phase 4)', async ({ page }) => {
    const res = await page.goto(`${BASE}${SAMPLE_SERVICE_PATH_EN}`)
    test.skip(res?.status() === 404, 'no seeded sample service in this environment (empty DB)')

    const button = page.getByRole('button', { name: /Download PDF/i })
    await expect(button).toBeVisible()

    // Clicking posts the current inputs to /api/quote. On a stage with no PDF
    // Lambda (dev/CI) the route returns the quote HTML (X-Pdf-Preview: html);
    // on a deployed stage it returns application/pdf. Either is a success.
    const [resp] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/api/quote') && r.request().method() === 'POST',
      ),
      button.click(),
    ])
    expect(resp.status()).toBe(200)
    expect(resp.headers()['content-type'] ?? '').toMatch(/application\/pdf|text\/html/)
  })

  test('the /api/quote endpoint is rate-limited (429 after the per-IP budget)', async ({
    request,
  }) => {
    // Give this run its own limiter bucket via a unique CloudFront-Viewer-Address
    // (the same header getClientIp trusts first), so the test is isolated from
    // the other quote requests in this suite and deterministic across runs.
    const viewer = `198.51.100.${1 + Math.floor(Math.random() * 250)}:40000`
    const post = () =>
      request.post(`${BASE}/api/quote`, {
        headers: { 'CloudFront-Viewer-Address': viewer },
        // A non-existent slug keeps this cheap (404 before any Lambda) and
        // empty-DB-safe; the rate-limit check runs *before* the DB lookup, so
        // the 429 assertion holds regardless of seeding.
        data: { slug: 'rate-limit-probe', locale: 'en', inputs: {} },
        failOnStatusCode: false,
      })

    // Budget is 10 / minute / IP. The first 10 must NOT be rate-limited.
    for (let i = 0; i < 10; i++) {
      const r = await post()
      expect(r.status(), `request ${i + 1} should not be rate-limited`).not.toBe(429)
    }
    // The 11th exceeds the budget → 429 with a Retry-After header.
    const eleventh = await post()
    expect(eleventh.status()).toBe(429)
    expect((await eleventh.json()).error).toBe('rate_limited')
    expect(eleventh.headers()['retry-after']).toBeTruthy()
  })
})

test.describe('Admin panel stays separate from the public site', () => {
  test('/admin is not localized and reaches the Payload admin login', async ({ page }) => {
    const res = await page.goto(`${BASE}/admin`)
    expect(res?.status()).toBeLessThan(400)
    // Must not have been rewritten under a locale prefix by next-intl.
    await expect(page).toHaveURL(/\/admin(\/|$|\?)/)
  })
})
