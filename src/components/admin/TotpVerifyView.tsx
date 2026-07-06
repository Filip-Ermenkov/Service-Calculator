import { redirect } from 'next/navigation'
import type { AdminViewServerProps } from 'payload'

import { isStepUpVerifiedFromCookieMap } from '@/lib/totp/requestHelpers'

import { TotpVerifyForm } from './TotpVerifyForm'

/** Root view at /admin/totp-verify — the per-login second-factor prompt. */
export default async function TotpVerifyView({ initPageResult }: AdminViewServerProps) {
  const { req, cookies } = initPageResult
  const user = req.user

  if (!user) {
    redirect('/admin/login')
  }

  if (!user.totpEnabled) {
    redirect('/admin/totp-setup')
  }

  if (isStepUpVerifiedFromCookieMap(cookies, String(user.id))) {
    redirect('/admin')
  }

  return (
    <div style={{ maxWidth: 400, margin: '48px auto', padding: '0 24px' }}>
      <h1>Two-factor verification</h1>
      <p>Enter the current code from your authenticator app to continue.</p>
      <TotpVerifyForm />
    </div>
  )
}
