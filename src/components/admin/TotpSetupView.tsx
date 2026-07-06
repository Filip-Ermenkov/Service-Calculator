import { redirect } from 'next/navigation'
import type { AdminViewServerProps } from 'payload'

import { isStepUpVerifiedFromCookieMap } from '@/lib/totp/requestHelpers'

import { TotpSetupForm } from './TotpSetupForm'

/**
 * Root view at /admin/totp-setup. Reachable in two situations:
 * 1. First-time enrollment — a logged-in (password only) admin whose
 *    account doesn't have 2FA configured yet. Only requires the password
 *    step, since there's no existing device/secret to protect.
 * 2. Re-linking a device (FUNCTIONALITY.md §5.8) — requires the CURRENT
 *    device's step-up cookie too (enforced here for the redirect, and
 *    independently by /api/users/totp/setup itself — see
 *    src/collections/Users.endpoints.ts for why both layers matter).
 */
export default async function TotpSetupView({ initPageResult }: AdminViewServerProps) {
  const { req, cookies } = initPageResult
  const user = req.user

  if (!user) {
    redirect('/admin/login')
  }

  if (user.totpEnabled && !isStepUpVerifiedFromCookieMap(cookies, String(user.id))) {
    redirect('/admin/totp-verify')
  }

  return (
    <div style={{ maxWidth: 480, margin: '48px auto', padding: '0 24px' }}>
      <h1>{user.totpEnabled ? 'Re-link two-factor authentication' : 'Set up two-factor authentication'}</h1>
      <p>
        Scan this QR code with an authenticator app (Google Authenticator, Authy, Microsoft
        Authenticator, 1Password, etc.), then enter the 6-digit code it shows to confirm.
      </p>
      <TotpSetupForm />
    </div>
  )
}
