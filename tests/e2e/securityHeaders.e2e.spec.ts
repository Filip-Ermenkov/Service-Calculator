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
  // OWASP Secure Headers Project lists X-Powered-By among the headers to REMOVE.
  // next.config.ts sets `poweredByHeader: false`; withPayload honours it and stops
  // appending its own "Next.js, Payload" value (this was live in production).
  expect(headers['x-powered-by'], 'X-Powered-By must not be emitted').toBeUndefined()
}

test.describe('Security headers', () => {
  test('the bare `/` locale redirect (a proxy-terminated response) carries the full header set', async ({ request }) => {
    // next.config `headers()` never sees a response the proxy terminates; the
    // `/` → `/<locale>` 307 shipped with NO security headers until the proxy
    // started applying the same set to its redirects (src/proxy.ts).
    const res = await request.get(`${BASE}/`, { maxRedirects: 0 })
    expect([307, 308]).toContain(res.status())
    expect(res.headers()['location']).toMatch(/^\/(en|fr|de)$|\/(en|fr|de)$/)
    assertHeaders(res.headers())
  })

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

  test('GraphQL is not served: /api/graphql and its playground are 404', async ({ request }) => {
    // graphQL.disable + the deleted route files (src/payload.config.ts). Nothing in
    // the app used GraphQL, and an unauthenticated query engine is pure attack
    // surface. Both paths now fall through to Payload's REST catch-all → 404.
    const post = await request.post(`${BASE}/api/graphql`, { data: { query: '{ __typename }' } })
    expect(post.status()).toBe(404)
    const playground = await request.get(`${BASE}/api/graphql-playground`)
    expect(playground.status()).toBe(404)
    assertHeaders(post.headers())
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
