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
  await page.fill('#totp-verify-code', code)
  await page.click('button[type="submit"]')

  await page.waitForURL(`${serverURL}/admin`)

  const dashboardArtifact = page.locator('.step-nav__home')
  await expect(dashboardArtifact).toBeVisible()
}
