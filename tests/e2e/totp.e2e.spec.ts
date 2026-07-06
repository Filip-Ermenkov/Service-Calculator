import { test, expect } from '@playwright/test'

import { generateTotpToken } from '../../src/lib/totp/otp'
import {
  cleanupUserByEmail,
  seedEnrolledTestUser,
  seedUnenrolledTestUser,
} from '../helpers/seedUser'

const BASE_URL = 'http://localhost:3000'

// Account under test for the first-time ENROLLMENT flow (starts with no 2FA).
const email = 'totp-e2e@example.com'
const password = 'totp-e2e-password'

// A SEPARATE, already-enrolled account for the "new session" flow below. Kept
// distinct from the enrollment account on purpose: reusing an account that was
// just enrolled means the new session's login code can land in the very same
// 30-second TOTP window whose time-step enrollment already consumed, which
// otplib's replay protection (correctly) rejects — a real, ~50-70%-of-runs
// source of flakiness. A pre-enrolled account with an untouched time-step
// models the realistic case (enrolled earlier, logging in fresh now) and makes
// the test deterministic. Fixed secret so the test can compute a live code.
const sessionEmail = 'totp-e2e-session@example.com'
const sessionPassword = 'totp-e2e-session-password'
const sessionSecret = 'SJPA2UZZG7ABPN2DYVD3TD36BTRTPYUD'

test.describe('Two-factor authentication', () => {
  test.beforeAll(async () => {
    await seedUnenrolledTestUser(email, password)
    await seedEnrolledTestUser(sessionEmail, sessionPassword, sessionSecret)
  })

  test.afterAll(async () => {
    await cleanupUserByEmail(email)
    await cleanupUserByEmail(sessionEmail)
  })

  test('first login forces enrollment before any admin data is reachable', async ({
    browser,
  }) => {
    const context = await browser.newContext()
    const page = await context.newPage()

    await page.goto(`${BASE_URL}/admin/login`)
    await page.fill('#field-email', email)
    await page.fill('#field-password', password)
    await page.click('button[type="submit"]')

    await page.waitForURL(`${BASE_URL}/admin/totp-setup`)

    // The gate is access control, not just where the dashboard link points —
    // confirm a direct navigation to a protected collection also redirects
    // here rather than rendering user data.
    await page.goto(`${BASE_URL}/admin/collections/users`)
    await expect(page).toHaveURL(`${BASE_URL}/admin/totp-setup`)

    const secretText = await page.locator('code').first().textContent()
    expect(secretText).toBeTruthy()
    const enrolledSecret = secretText!.trim()

    const code = await generateTotpToken(enrolledSecret)
    await page.fill('#totp-code', code)
    await page.click('button[type="submit"]')

    await page.waitForURL(`${BASE_URL}/admin`)
    await expect(page.locator('.step-nav__home')).toBeVisible()

    await context.close()
  })

  test('a new session rejects a wrong code and accepts the correct one', async ({ browser }) => {
    // A brand-new browser context has no leftover step-up cookie, so this
    // exercises the real per-session guarantee: any new session must pass both
    // factors, every time. Uses its own already-enrolled account (see the
    // sessionSecret note above) so it neither depends on the enrollment test
    // above nor collides with that enrollment's just-consumed TOTP time-step.
    const context = await browser.newContext()
    const page = await context.newPage()

    await page.goto(`${BASE_URL}/admin/login`)
    await page.fill('#field-email', sessionEmail)
    await page.fill('#field-password', sessionPassword)
    await page.click('button[type="submit"]')

    await page.waitForURL(`${BASE_URL}/admin/totp-verify`)

    await page.fill('#totp-verify-code', '000000')
    await page.click('button[type="submit"]')
    await expect(page.getByText(/invalid code/i)).toBeVisible()
    await expect(page).toHaveURL(`${BASE_URL}/admin/totp-verify`)

    // Still gated — the wrong attempt above must not have granted anything.
    await page.goto(`${BASE_URL}/admin/collections/users`)
    await expect(page).toHaveURL(`${BASE_URL}/admin/totp-verify`)

    const code = await generateTotpToken(sessionSecret)
    await page.fill('#totp-verify-code', code)
    await page.click('button[type="submit"]')

    await page.waitForURL(`${BASE_URL}/admin`)
    await expect(page.locator('.step-nav__home')).toBeVisible()

    await context.close()
  })
})
