import { test, expect } from '@playwright/test'

const BASE = 'http://localhost:3000'

// The files in public/ are served at fixed, well-known paths, and the pages
// link to them. tests/int/discoveryFiles.int.spec.ts checks their CONTENT; this
// proves a running server actually SERVES them. In particular, the proxy matcher
// must let dotted paths through untouched: a 307 to `/en/favicon.ico` would be a
// silent 404 for every browser and crawler.
//
// On deployed stages the CDN serves the same files straight from S3. SST routes
// public/'s top-level files and its `.well-known/` directory there explicitly.

test.describe('Well-known and brand files', () => {
  for (const [path, type] of [
    ['/.well-known/security.txt', 'text/plain'],
    ['/favicon.ico', 'image/'],
    ['/icon.svg', 'image/svg+xml'],
    ['/apple-touch-icon.png', 'image/png'],
    ['/og-image.png', 'image/png'],
    ['/site.webmanifest', ''],
  ] as const) {
    test(`${path} is served directly`, async ({ request }) => {
      const res = await request.get(`${BASE}${path}`, { maxRedirects: 0 })
      expect(res.status()).toBe(200)
      expect(res.headers()['content-type'] ?? '').toContain(type)
    })
  }

  test('pages link the icons, the manifest and a large share card', async ({ page }) => {
    await page.goto(`${BASE}/en`)
    const head = page.locator('head')
    await expect(head.locator('link[rel="icon"][href="/icon.svg"]')).toHaveCount(1)
    await expect(head.locator('link[rel="apple-touch-icon"]')).toHaveCount(1)
    await expect(head.locator('link[rel="manifest"]')).toHaveCount(1)
    await expect(head.locator('meta[property="og:image"]')).toHaveAttribute(
      'content',
      /\/og-image\.png$/,
    )
    await expect(head.locator('meta[name="twitter:card"]')).toHaveAttribute(
      'content',
      'summary_large_image',
    )
  })

  test('the Home page describes the business for search engines', async ({ page }) => {
    await page.goto(`${BASE}/en`)
    const raw = await page.locator('script[type="application/ld+json"]').first().textContent()
    const data = JSON.parse(raw ?? '{}')
    expect(data['@type']).toBe('HomeAndConstructionBusiness')
    expect(data['@id']).toMatch(/#business$/)
    expect(data.logo).toMatch(/\/icon-512\.png$/)
  })
})
