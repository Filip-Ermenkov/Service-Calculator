import { test, expect } from '@playwright/test'

const BASE = 'http://localhost:3000'

// Proves the security headers configured in next.config.ts are actually EMITTED
// by the running Next server (the int test only proves the shared module is
// correct). Runs against every route class: a public localized page, the
// unlocalized admin login, and the /api/quote route — all should carry them,
// since next.config `headers()` matches `/:path*`.
//
// Empty-DB-safe: only asserts response headers, never page content, so it is
// green on CI's empty Postgres just like the rest of the public suite.

const EXPECTED: Record<string, RegExp> = {
  'strict-transport-security': /max-age=63072000/i,
  'x-content-type-options': /nosniff/i,
  'referrer-policy': /strict-origin-when-cross-origin/i,
  'x-frame-options': /SAMEORIGIN/i,
  'x-xss-protection': /^0$/,
  'x-permitted-cross-domain-policies': /none/i,
  'cross-origin-opener-policy': /same-origin/i,
  'permissions-policy': /camera=\(\)/i,
  'content-security-policy': /frame-ancestors 'self'/i,
}

function assertHeaders(headers: Record<string, string>) {
  for (const [key, pattern] of Object.entries(EXPECTED)) {
    expect(headers[key], `missing/incorrect header: ${key}`).toBeDefined()
    expect(headers[key]).toMatch(pattern)
  }
}

test.describe('Security headers', () => {
  test('a public localized page carries the full header set', async ({ request }) => {
    const res = await request.get(`${BASE}/en`)
    expect(res.status()).toBe(200)
    assertHeaders(res.headers())
  })

  test('the admin login page carries the full header set', async ({ request }) => {
    const res = await request.get(`${BASE}/admin/login`)
    // 200 (login form) or a redirect — either way headers must be present.
    expect(res.status()).toBeLessThan(400)
    assertHeaders(res.headers())
  })

  test('the /api/quote route carries the full header set', async ({ request }) => {
    // A bad-slug POST short-circuits to 404 without touching the DB/PDF Lambda,
    // which is all we need — the security headers ride on every response.
    const res = await request.post(`${BASE}/api/quote`, {
      data: { slug: '__no_such_service__', locale: 'en', inputs: {} },
    })
    expect([400, 404, 502]).toContain(res.status())
    assertHeaders(res.headers())
  })
})
