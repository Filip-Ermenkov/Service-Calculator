'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'

type SetupResponse = {
  secret: string
  otpAuthUri: string
  qrCodeDataUrl: string
}

/**
 * Client half of the /admin/totp-setup view. Calls the two setup endpoints
 * (see src/collections/Users.endpoints.ts):
 * 1. POST /api/users/totp/setup on mount — generates a fresh secret, returns
 *    a QR code + the raw base32 secret for manual entry.
 * 2. POST /api/users/totp/enable, once the admin has scanned it and typed
 *    back the 6-digit code their app now generates — confirms the secret is
 *    correctly provisioned before it's trusted for real logins.
 */
export function TotpSetupForm() {
  const router = useRouter()
  const [setupData, setSetupData] = useState<SetupResponse | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function loadSetup() {
      setLoading(true)
      setError(null)
      try {
        const res = await fetch('/api/users/totp/setup', {
          method: 'POST',
          credentials: 'include',
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? 'Failed to start 2FA setup')
        if (!cancelled) setSetupData(data)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to start 2FA setup')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void loadSetup()
    return () => {
      cancelled = true
    }
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/users/totp/enable', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Invalid code')
      router.push('/admin')
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid code')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return <p>Preparing your 2FA setup&hellip;</p>
  if (error && !setupData) return <p style={{ color: 'var(--theme-error-500, #d00)' }}>{error}</p>
  if (!setupData) return null

  return (
    <div>
      {/* eslint-disable-next-line @next/next/no-img-element -- data: URL, no Next image optimization applies */}
      <img
        src={setupData.qrCodeDataUrl}
        alt="Scan this QR code with your authenticator app"
        width={256}
        height={256}
      />
      <p>
        Can&apos;t scan? Enter this code manually: <code>{setupData.secret}</code>
      </p>
      <form onSubmit={handleSubmit}>
        <label htmlFor="totp-code">Enter the 6-digit code from your app</label>
        <input
          id="totp-code"
          name="code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          required
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
        />
        {error && <p style={{ color: 'var(--theme-error-500, #d00)' }}>{error}</p>}
        <button type="submit" disabled={submitting || code.length !== 6}>
          {submitting ? 'Verifying&hellip;' : 'Confirm and enable 2FA'}
        </button>
      </form>
    </div>
  )
}
