import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'

import { generateTotpToken } from '../../src/lib/totp/otp.js'

export interface LoginOptions {
  page: Page
  serverURL?: string
  user: {
    email: string
    password: string
  }
  /**
   * Base32 TOTP secret for this user. Required for any account with 2FA
   * already enabled (the default for testUser — see seedUser.ts) so this
   * helper can complete the mandatory second-factor step. Omit only when
   * logging in as an account that has NOT enrolled in 2FA yet (the helper
   * then stops at /admin/totp-setup rather than trying to verify).
   */
  totpSecret?: string
}

/**
 * Enters a 6-digit code on the TOTP verification screen.
 *
 * That screen is six single-character boxes (`.amfa-otp__box`), not one field —
 * see src/components/admin/TotpVerifyForm.tsx — so `fill()` cannot be pointed at
 * a single input: each box is `maxLength={1}` and keeps only the last character
 * it is given. Typing is also the honest thing to exercise here, because it puts
 * the component's own auto-advance on the hook: if focus stops moving between
 * boxes, every test that logs in fails, which is exactly the signal you want.
 */
export async function fillTotpCode(page: Page, code: string): Promise<void> {
  await page.locator('.amfa-otp__box').first().click()
  await page.keyboard.type(code)
}

/**
 * Logs the user into the admin panel via the login page, then — since 2FA
 * is mandatory for every admin account (FUNCTIONALITY.md §5.1) — completes
 * the TOTP verification step too when `totpSecret` is provided.
 */
export async function login({
  page,
  serverURL = 'http://localhost:3000',
  user,
  totpSecret,
}: LoginOptions): Promise<void> {
  await page.goto(`${serverURL}/admin/login`)

  await page.fill('#field-email', user.email)
  await page.fill('#field-password', user.password)
  await page.click('button[type="submit"]')

  if (!totpSecret) {
    // Caller is testing the unenrolled path themselves (e.g.
    // totp.e2e.spec.ts) — stop here rather than assume where they land.
    return
  }

  await page.waitForURL(`${serverURL}/admin/totp-verify`)

  const code = await generateTotpToken(totpSecret)
  await fillTotpCode(page, code)
  await page.click('button[type="submit"]')

  await page.waitForURL(`${serverURL}/admin`)

  // The dashboard's own greeting heading. (Not the top-bar page title: that is
  // published to Payload's StepNav from a client effect, so it settles a beat
  // after navigation, whereas this is server-rendered with the view.)
  const dashboardArtifact = page.locator('.adash-greet__title')
  await expect(dashboardArtifact).toBeVisible()
}
