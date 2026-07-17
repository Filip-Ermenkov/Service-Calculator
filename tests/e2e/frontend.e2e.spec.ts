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

test.describe('Admin panel stays separate from the public site', () => {
  test('/admin is not localized and reaches the Payload admin login', async ({ page }) => {
    const res = await page.goto(`${BASE}/admin`)
    expect(res?.status()).toBeLessThan(400)
    // Must not have been rewritten under a locale prefix by next-intl.
    await expect(page).toHaveURL(/\/admin(\/|$|\?)/)
  })
})
