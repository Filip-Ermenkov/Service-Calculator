import { test, expect, type Page } from '@playwright/test'

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

test.describe('Public site — crawl signals (sitemap + hreflang)', () => {
  test('the sitemap lists every locale of the static pages with NO invented lastmod', async ({
    request,
  }) => {
    const res = await request.get(`${BASE}/sitemap.xml`)
    expect(res.status()).toBe(200)
    const xml = await res.text()
    for (const locale of ['en', 'fr', 'de']) {
      expect(xml).toContain(`/${locale}/projects</loc>`)
      expect(xml).toContain(`/${locale}/contact</loc>`)
    }
    // A static page has no real modification time, so it must not claim one:
    // its <url> block ends right after the alternates, with no <lastmod>. (A
    // CMS service — seeded in CI as ci-sample-service — DOES carry its updatedAt.)
    const staticBlock = /<url>\s*<loc>[^<]*\/en\/contact<\/loc>[\s\S]*?<\/url>/.exec(xml)?.[0] ?? ''
    expect(staticBlock).not.toBe('')
    expect(staticBlock).not.toContain('<lastmod>')
    const serviceBlock = /<url>\s*<loc>[^<]*\/en\/services\/[^<]+<\/loc>[\s\S]*?<\/url>/.exec(xml)?.[0]
    if (serviceBlock) expect(serviceBlock).toContain('<lastmod>')
  })

  test('x-default hreflang points at the language-negotiating unprefixed URL in BOTH the HTML and the Link header', async ({
    request,
  }) => {
    // Two sources of hreflang exist: the <link rel="alternate"> tags from
    // generateMetadata (src/lib/seo.ts) and the `Link:` header next-intl adds.
    // They used to disagree on x-default (`/en/projects` vs `/projects`); a
    // crawler given two answers picks one at random. Now both say the same thing.
    const res = await request.get(`${BASE}/en/projects`)
    expect(res.status()).toBe(200)
    const html = await res.text()
    const tag = /<link[^>]*hreflang="x-default"[^>]*>/i.exec(html)?.[0] ?? ''
    expect(tag).toMatch(/href="[^"]*\/projects"/)
    expect(tag).not.toMatch(/href="[^"]*\/(en|fr|de)\/projects"/)
    const link = res.headers()['link'] ?? ''
    const headerDefault = /<([^>]+)>;\s*rel="alternate";\s*hreflang="x-default"/i.exec(link)?.[1] ?? ''
    expect(headerDefault).toMatch(/\/projects$/)
    expect(headerDefault).not.toMatch(/\/(en|fr|de)\/projects$/)
  })
})

test.describe('Public site — pages render', () => {
  for (const path of ['/en', '/en/projects', '/en/about', '/en/careers', '/en/contact', '/en/legal', '/en/privacy']) {
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

  test('the "email me the quote" flow validates and confirms (Phase 4 part 2)', async ({
    page,
  }) => {
    const res = await page.goto(`${BASE}${SAMPLE_SERVICE_PATH_EN}`)
    test.skip(res?.status() === 404, 'no seeded sample service in this environment (empty DB)')

    // Reveal the inline email prompt.
    await page.getByRole('button', { name: /Email me the quote/i }).click()
    const input = page.getByPlaceholder(/@/)
    await expect(input).toBeVisible()

    // Client-side validation: an obviously-bad address is rejected WITHOUT a
    // network round-trip (the server never sees it).
    await input.fill('not-an-email')
    await page.getByRole('button', { name: /^Send$/i }).click()
    await expect(page.getByText(/valid email address/i)).toBeVisible()

    // A valid address posts mode:'email'; mock the send so the test is
    // deterministic without a verified SES identity, and assert the confirmation.
    await page.route('**/api/quote', async (route) => {
      const body = route.request().postDataJSON() as { mode?: string }
      if (body?.mode === 'email') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true }),
        })
      } else {
        await route.continue()
      }
    })
    await input.fill('visitor@example.com')
    await page.getByRole('button', { name: /^Send$/i }).click()
    await expect(page.getByText(/Check your inbox/i)).toBeVisible()
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

// Phase 6 — contact form + spam protection. Environment-agnostic: the /contact
// page and its form render regardless of DB seeding (contact DETAILS come from
// CompanyInfo, but the form is always present). Turnstile is unconfigured in
// CI/local, so the widget doesn't render and no token is required — the client
// flow (validation → mocked success) and the server defences (rate limit,
// honeypot) are what's proven here; real Turnstile is verified in the manual guide.
test.describe('Public site — contact form (Phase 6)', () => {
  /**
   * Open the contact page and wait until React has hydrated the form. The form's
   * submit path is entirely client-side, so it renders with the button disabled
   * and flags `data-hydrated` once interactive (src/components/site/ContactForm.tsx).
   * Filling before that point is a race the dev server's first compile of the
   * page can lose: a controlled input filled pre-hydration is reset to '' when
   * React takes over (seen once as "Your name" arriving empty at the server).
   */
  async function openContactForm(page: Page) {
    const res = await page.goto(`${BASE}/en/contact`)
    await expect(page.locator('form.contact-form')).toHaveAttribute('data-hydrated', 'true')
    return res
  }

  test('the contact page renders the form and is linked from the nav', async ({ page, request }) => {
    // The server HTML ships the submit button DISABLED: without JavaScript the
    // form has no submit path, and a click before hydration would otherwise be
    // a native submit that reloads the page and discards what was typed.
    const html = await (await request.get(`${BASE}/en/contact`)).text()
    const submit = /<button[^>]*type="submit"[^>]*>/i.exec(html)?.[0] ?? ''
    expect(submit).not.toBe('')
    expect(submit).toContain('disabled')
    expect(html).not.toContain('data-hydrated')

    const res = await openContactForm(page)
    expect(res?.status()).toBeLessThan(400)
    await expect(page.getByLabel(/Your name/i)).toBeVisible()
    await expect(page.getByLabel(/Email address/i)).toBeVisible()
    await expect(page.getByLabel(/Message/i)).toBeVisible()
    // …and once hydrated it is live.
    await expect(page.getByRole('button', { name: /Send message/i })).toBeEnabled()
  })

  test('client-side validation blocks an empty/invalid submit without a round-trip', async ({
    page,
  }) => {
    let posted = false
    await page.route('**/api/contact', async (route) => {
      posted = true
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
    })
    await openContactForm(page)
    await page.getByRole('button', { name: /Send message/i }).click()
    // Scope to the form's own alert — Next renders a global (empty) route
    // announcer with role="alert" too, so an unscoped getByRole is ambiguous.
    await expect(page.locator('form.contact-form [role="alert"]')).toBeVisible()
    expect(posted, 'no network request should be made on an invalid form').toBe(false)
  })

  test('a valid submission posts to /api/contact and shows the confirmation', async ({ page }) => {
    await page.route('**/api/contact', async (route) => {
      const body = route.request().postDataJSON() as { name?: string; message?: string }
      // Assert the client sends the expected shape.
      expect(body?.name).toBeTruthy()
      expect(body?.message).toBeTruthy()
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
    })
    await openContactForm(page)
    await page.getByLabel(/Your name/i).fill('Jane Tester')
    await page.getByLabel(/Email address/i).fill('jane@example.com')
    await page.getByLabel(/Message/i).fill('I would like a quote for a heat pump.')
    await page.getByRole('button', { name: /Send message/i }).click()
    await expect(page.getByText(/Message sent/i)).toBeVisible()
  })

  test('the /api/contact endpoint is rate-limited (429 after the per-IP budget)', async ({
    request,
  }) => {
    // Own limiter bucket via a unique CloudFront-Viewer-Address (getClientIp trusts
    // it first), isolating this run. Budget is 5 / minute / IP.
    const viewer = `203.0.113.${1 + Math.floor(Math.random() * 250)}:40000`
    const post = () =>
      request.post(`${BASE}/api/contact`, {
        headers: { 'CloudFront-Viewer-Address': viewer },
        // Deliberately invalid body: the rate-limit check runs BEFORE validation,
        // so the 429 assertion holds without needing a real send path.
        data: { name: '', email: '', message: '' },
        failOnStatusCode: false,
      })

    for (let i = 0; i < 5; i++) {
      const r = await post()
      expect(r.status(), `request ${i + 1} should not be rate-limited`).not.toBe(429)
    }
    const sixth = await post()
    expect(sixth.status()).toBe(429)
    expect((await sixth.json()).error).toBe('rate_limited')
    expect(sixth.headers()['retry-after']).toBeTruthy()
  })

  test('the honeypot silently accepts (200) a bot submission without sending', async ({
    request,
  }) => {
    const viewer = `203.0.113.${1 + Math.floor(Math.random() * 250)}:41000`
    const res = await request.post(`${BASE}/api/contact`, {
      headers: { 'CloudFront-Viewer-Address': viewer },
      // A filled honeypot ("company") marks this as a bot. The route returns 200
      // as if accepted (never revealing the trap) but sends nothing.
      data: {
        name: 'Spam Bot',
        email: 'bot@example.com',
        message: 'buy cheap stuff',
        company: 'filled-by-a-bot',
      },
      failOnStatusCode: false,
    })
    expect(res.status()).toBe(200)
    expect((await res.json()).ok).toBe(true)
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
