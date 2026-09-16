import { test, expect } from '@playwright/test'

import { signStepUpToken } from '../../src/lib/totp/stepUpToken'
import { cleanupUserByEmail, seedEnrolledTestUser } from '../helpers/seedUser'

const BASE = 'http://localhost:3000'

// Admin account recovery + Payload's CSRF origin allowlist, against the RUNNING
// server (2026-09-16). The int suite (tests/int/emailAdapter.int.spec.ts) proves
// the operation and the adapter; this proves the real HTTP + UI path:
//
//   • "Forgot your password?" is a working flow — the form submits, the route
//     answers 200 and the admin sees Payload's "Email Sent" state. (On this dev
//     server EMAIL_SENDER is unset, so the adapter prints the reset link to the
//     server console instead of sending — see payloadEmailAdapter.ts.)
//   • The unauthenticated forgot-password endpoint is rate-limited per IP and per
//     address (an SES send per call otherwise). Both keys are made unique per
//     run — a CloudFront-Viewer-Address header for the IP bucket, a random
//     address — so a re-run against the same dev server (in-memory limiter, 15
//     minute window) cannot poison itself, the same trick the /api/quote case uses.
//   • A `payload-token` cookie is honoured only from this origin: replayed with a
//     foreign `Origin` header, /api/users/me sees no user. This is Payload's own
//     CSRF allowlist, which was empty (= disabled) until `serverURL` was set.
//   • The proxy's admin-gate redirect (password-only session → /admin/totp-verify)
//     is a proxy-terminated 3xx and now carries the security header set too.

const email = `recovery-e2e-${Date.now()}@example.com`
const password = 'recovery-e2e-password'
const secret = 'KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU'

const SECURITY_HEADERS = [
  'strict-transport-security',
  'content-security-policy',
  'x-content-type-options',
  'referrer-policy',
  'x-frame-options',
  'permissions-policy',
]

test.describe('Admin account recovery + CSRF allowlist', () => {
  test.beforeAll(async () => {
    await seedEnrolledTestUser(email, password, secret)
  })

  test.afterAll(async () => {
    await cleanupUserByEmail(email)
  })

  test('the "Forgot Password" screen submits and reaches the Email Sent state', async ({ page }) => {
    // A unique IP bucket for THIS run's browser traffic, so repeated local runs
    // against the same dev server never exhaust the forgot-password budget.
    await page.setExtraHTTPHeaders({ 'CloudFront-Viewer-Address': `198.51.100.${Math.floor(Math.random() * 254) + 1}:443` })
    await page.goto(`${BASE}/admin/forgot`)
    // The admin app hydrates client-side, and on a dev server this route may be
    // compiling for the first time while other specs run — allow for that
    // rather than the 5s default (the same cold-start class docs/PROGRESS.md
    // records for the admin suites).
    await expect(page.locator('#field-email')).toBeVisible({ timeout: 60_000 })
    await expect(page.locator('h1').first()).toContainText(/Forgot Password|Reset Password/)

    const forgotResponse = page.waitForResponse(
      (res) => res.url().includes('/api/users/forgot-password') && res.request().method() === 'POST',
    )
    await page.fill('#field-email', email)
    await page.click('button[type="submit"]')

    const res = await forgotResponse
    expect(res.status()).toBe(200)
    await expect(page.locator('h1').first()).toContainText('Email Sent')
  })

  test('forgot-password is rate-limited: 5 requests pass, the 6th is 429 (unique IP + address per run)', async ({ request }) => {
    const ip = `203.0.113.${Math.floor(Math.random() * 254) + 1}:${10_000 + Math.floor(Math.random() * 50_000)}`
    const target = `nobody-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`
    const headers = { 'CloudFront-Viewer-Address': ip }

    for (let i = 1; i <= 5; i++) {
      const res = await request.post(`${BASE}/api/users/forgot-password`, { data: { email: target }, headers })
      expect(res.status(), `request ${i} should be accepted`).toBe(200)
    }
    const sixth = await request.post(`${BASE}/api/users/forgot-password`, { data: { email: target }, headers })
    expect(sixth.status()).toBe(429)
  })

  test('a session cookie is only honoured from this origin; the admin gate redirect carries the security headers', async ({ request }) => {
    const login = await request.post(`${BASE}/api/users/login`, {
      data: { email, password },
      headers: { Origin: BASE },
    })
    expect(login.status()).toBe(200)
    const setCookie = login.headers()['set-cookie'] ?? ''
    const token = /payload-token=([^;]+)/.exec(setCookie)?.[1]
    expect(token, 'login must set the payload-token cookie').toBeTruthy()
    const userId = String(((await login.json()) as { user: { id: number | string } }).user.id)
    const passwordOnlyCookie = `payload-token=${token}`
    // A FULLY verified session (password + completed TOTP step-up): `/me`
    // re-reads the user with access control on, and Users.read requires the
    // second factor, so a password-only cookie gets 403 here BY DESIGN — that
    // is the 2FA gate, not the CSRF allowlist under test.
    const verifiedCookie = `${passwordOnlyCookie}; bulbau-totp-verified=${signStepUpToken(userId)}`

    // Same origin → Payload recognises the session.
    const sameOrigin = await request.get(`${BASE}/api/users/me`, {
      headers: { cookie: verifiedCookie, Origin: BASE },
    })
    expect(sameOrigin.status()).toBe(200)
    expect(((await sameOrigin.json()) as { user: unknown }).user).not.toBeNull()

    // Foreign origin → the SAME cookies are ignored (CSRF allowlist = serverURL):
    // Payload sees no session at all, so there is nothing for the 2FA gate to
    // refuse — a plain anonymous `{ user: null }`.
    const foreign = await request.get(`${BASE}/api/users/me`, {
      headers: { cookie: verifiedCookie, Origin: 'https://evil.example' },
    })
    expect(foreign.status()).toBe(200)
    expect(((await foreign.json()) as { user: unknown }).user).toBeNull()

    // The proxy's own redirect (password-only session hitting /admin) is a
    // response next.config `headers()` never decorates — the proxy does now.
    const gate = await request.get(`${BASE}/admin`, { headers: { cookie: passwordOnlyCookie }, maxRedirects: 0 })
    expect(gate.status()).toBe(307)
    expect(gate.headers()['location']).toMatch(/\/admin\/totp-verify$/)
    for (const h of SECURITY_HEADERS) {
      expect(gate.headers()[h], `missing ${h} on the admin gate redirect`).toBeDefined()
    }
    expect(gate.headers()['x-powered-by']).toBeUndefined()
  })
})
