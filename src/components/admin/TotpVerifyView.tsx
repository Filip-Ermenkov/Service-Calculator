import Link from 'next/link'
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
    <div className="amfa">
      <div className="amfa-card">
        <span className="amfa-mark amfa-mark--tint" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="4" y="11" width="16" height="10" rx="1" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
        </span>
        <h1 className="amfa-title">Two-factor authentication</h1>
        <p className="amfa-sub">Open Google Authenticator and enter the 6-digit code for Bulbau Admin.</p>
        <TotpVerifyForm />
        <Link className="amfa-alt" href="/admin/logout">&larr; Use a different account</Link>
      </div>
    </div>
  )
}
