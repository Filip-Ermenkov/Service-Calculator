'use client'

import { useEffect, useRef, useState } from 'react'

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
  const [setupData, setSetupData] = useState<SetupResponse | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  // ONE setup request per mounted view, shared across React StrictMode's
  // deliberate double-invoke of effects in development.
  //
  // Why this matters beyond tidiness: POST /api/users/totp/setup GENERATES A
  // FRESH TOTP SECRET on every call and is rate-limited to 5 per 5 minutes per
  // user (src/collections/Users.endpoints.ts). Firing it twice per mount burned
  // half that budget for nothing, and enrolment legitimately renders this view
  // more than once (land here, navigate to a gated route, get redirected back),
  // so a real admin could hit "Too many attempts" while simply trying to set up
  // 2FA — which is also how this surfaced, as a test failure after a Next minor
  // upgrade shifted how many times the view mounts.
  //
  // The promise is held in a ref rather than guarding with a boolean: a plain
  // "already requested, bail out" flag is subtly wrong here, because StrictMode
  // runs effect → cleanup → effect on the SAME instance. The cleanup marks the
  // first invocation stale, so if the second one bails out, the in-flight
  // response is discarded by the first and nothing ever sets state — the view
  // hangs on "Preparing your 2FA setup…" forever. Both invocations must attach
  // to the same promise so whichever one is still live commits the result.
  const setupPromise = useRef<Promise<SetupResponse> | null>(null)

  useEffect(() => {
    let live = true

    if (!setupPromise.current) {
      setupPromise.current = (async () => {
        const res = await fetch('/api/users/totp/setup', {
          method: 'POST',
          credentials: 'include',
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? 'Failed to start 2FA setup')
        return data as SetupResponse
      })()
    }

    setupPromise.current
      .then((data) => {
        if (!live) return
        setSetupData(data)
        setError(null)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (!live) return
        // A failed attempt must not be cached as the permanent answer — clear it
        // so a remount (or the admin reloading the page) can try again.
        setupPromise.current = null
        setError(err instanceof Error ? err.message : 'Failed to start 2FA setup')
        setLoading(false)
      })

    return () => {
      live = false
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
      // HARD navigation — see the long note (and the captured request trace) in
      // TotpVerifyForm.tsx. Enrolling issues the same step-up cookie proxy.ts
      // gates on, so a soft push can replay a cached pre-cookie redirect and
      // bounce the admin straight back here.
      //
      // Discarding the framework's prefetched state is the intent, not a side
      // effect: it was captured under the old authorisation. Full reasoning and
      // the captured request trace are in TotpVerifyForm.tsx.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign('/admin')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid code')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return <p className="amfa-sub">Preparing your 2FA setup&hellip;</p>
  if (error && !setupData) return <p className="amfa-error" role="alert">{error}</p>
  if (!setupData) return null

  return (
    <div className="amfa-setup">
      <div className="amfa-qr">
        {/* eslint-disable-next-line @next/next/no-img-element -- data: URL, no Next image optimization applies */}
        <img
          src={setupData.qrCodeDataUrl}
          alt="Scan this QR code with your authenticator app"
          width={200}
          height={200}
        />
      </div>
      <p className="amfa-secret">
        Can&apos;t scan? Enter this code manually:
        <code>{setupData.secret}</code>
      </p>
      <form className="amfa-form" onSubmit={handleSubmit}>
        <label className="amfa-label" htmlFor="totp-code">6-digit code from your app</label>
        <input
          id="totp-code"
          className="amfa-code"
          name="code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          required
          placeholder="000000"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
        />
        {error && <p className="amfa-error" role="alert">{error}</p>}
        <button className="amfa-btn" type="submit" disabled={submitting || code.length !== 6}>
          {submitting ? 'Verifying&hellip;' : 'Confirm and enable 2FA'}
        </button>
      </form>
    </div>
  )
}
