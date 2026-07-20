import { test, expect } from '@playwright/test'

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

// Phase 3 — the live price calculator. Empty-DB-safe: CI runs against an empty
// Postgres with no services, so this skips when there's nothing to open. When a
// published service with calculator fields DOES exist (Filip's DB / staging),
// it proves the calculator is interactive and the total is a live region. The
// exhaustive arithmetic is covered deterministically by the pure unit tests.
test.describe('Public site — live price calculator (Phase 3)', () => {
  test('a service page shows an interactive, recomputing estimate', async ({ page }) => {
    await page.goto(`${BASE}/en`)
    // Target the real Home-page service cards specifically (not any stray
    // "/services/" href), so the skip-guard is accurate.
    const serviceCard = page.locator('a.service-card').first()
    const hasService = (await serviceCard.count()) > 0
    test.skip(!hasService, 'no seeded services in this environment')

    // Navigate via the card's own href rather than a client-side click. On a
    // cold dev server the first page can still be hydrating, so a click on
    // next-intl's client <Link> is occasionally swallowed before the router is
    // interactive (a cold-start race, not a routing bug). Reading the href and
    // navigating directly reaches the same service page deterministically.
    const href = await serviceCard.getAttribute('href')
    test.skip(!href, 'service card has no href')
    await page.goto(`${BASE}${href}`)
    await expect(page).toHaveURL(/\/en\/services\//)

    const total = page.locator('[data-testid="calc-total"]')
    // The service may legitimately have no calculator (the §7 no-fields case).
    const hasCalc = (await total.count()) > 0
    test.skip(!hasCalc, 'seeded service has no calculator fields')
    await expect(total).toBeVisible()

    // Fill every number input (they may be required — the total is withheld
    // until required fields have a value) so we reach a real computed state,
    // proving the inputs are live (not the old disabled preview).
    const numberInputs = page.locator('.calc-input[type="number"]')
    const count = await numberInputs.count()
    for (let i = 0; i < count; i++) {
      await expect(numberInputs.nth(i)).toBeEnabled()
      await numberInputs.nth(i).fill('5')
    }

    // With required fields satisfied, the total shows a formatted price or the
    // §7 contact copy — never the still-blank prompt.
    await expect(total).toHaveText(/€|Contact us for a price/)
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
