import { test, expect } from '@playwright/test'

const BASE = 'http://localhost:3000'

// Proves GET /api/health behaves correctly on a REAL running server, not just as
// an imported function (the unit-level branches — the 503 "degraded" path and
// the no-leak policy — are covered in tests/int/observability.int.spec.ts).
//
// This endpoint is the target of the Route 53 uptime check defined in
// infra/terraform/uptime.tf, so what is asserted here is a live contract with
// infrastructure rather than an internal detail: the health check is configured
// for HTTPS GET /api/health and treats 2xx as healthy. If the path moved, the
// status code changed, or a redirect appeared in front of it, the production
// alarm would either go permanently red (paging on a healthy site) or — worse —
// permanently green.
//
// Empty-DB-safe by construction: the endpoint deliberately never touches the
// database (see the route's module comment on Neon scale-to-zero), so it is
// green on CI's empty Postgres.

test.describe('GET /api/health — uptime probe contract', () => {
  test('returns 200 with a JSON ok status', async ({ request }) => {
    const res = await request.get(`${BASE}/api/health`)

    expect(res.status()).toBe(200)
    expect(res.headers()['content-type']).toContain('application/json')

    const body = await res.json()
    expect(body.status).toBe('ok')
    expect(typeof body.stage).toBe('string')
    expect(new Date(body.time).toString()).not.toBe('Invalid Date')
  })

  test('is never cached, so a green probe means the ORIGIN answered', async ({ request }) => {
    const res = await request.get(`${BASE}/api/health`)
    expect(res.headers()['cache-control']).toContain('no-store')
  })

  test('is reached directly — no locale redirect in front of it', async ({ request }) => {
    // /api/* is excluded from src/proxy.ts's matcher. If that ever regressed,
    // next-intl would 307 this to /en/api/health and Route 53 would still call
    // the check healthy (3xx counts as healthy) while monitoring nothing.
    const res = await request.get(`${BASE}/api/health`, { maxRedirects: 0 })
    expect(res.status()).toBe(200)
  })

  test('carries the standard security headers like every other route', async ({ request }) => {
    const res = await request.get(`${BASE}/api/health`)
    expect(res.headers()['x-content-type-options']).toBe('nosniff')
    expect(res.headers()['strict-transport-security']).toContain('max-age=63072000')
  })

  test('does not leak deployment internals in the body', async ({ request }) => {
    const raw = await (await request.get(`${BASE}/api/health`)).text()
    for (const secretName of ['DATABASE_URL', 'PAYLOAD_SECRET', 'TOTP_ENCRYPTION_KEY']) {
      expect(raw).not.toContain(secretName)
    }
  })
})
