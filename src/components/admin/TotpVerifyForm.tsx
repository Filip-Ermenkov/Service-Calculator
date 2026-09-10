'use client'

import { useRef, useState } from 'react'

/**
 * Client half of /admin/totp-verify — the per-login second-factor prompt.
 * Six single-character boxes (matching the prototype) with auto-advance,
 * backspace-to-previous, and paste-to-fill; the joined value is posted to
 * POST /api/users/totp/verify (see src/collections/Users.endpoints.ts).
 */
export function TotpVerifyForm() {
  const [digits, setDigits] = useState<string[]>(['', '', '', '', '', ''])
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const refs = useRef<Array<HTMLInputElement | null>>([])

  const code = digits.join('')

  const focusBox = (i: number) => refs.current[i]?.focus()

  const setDigit = (i: number, raw: string) => {
    const v = raw.replace(/\D/g, '').slice(-1)
    setDigits((prev) => {
      const next = [...prev]
      next[i] = v
      return next
    })
    if (v && i < 5) focusBox(i + 1)
  }

  const onKeyDown = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !digits[i] && i > 0) focusBox(i - 1)
    if (e.key === 'ArrowLeft' && i > 0) focusBox(i - 1)
    if (e.key === 'ArrowRight' && i < 5) focusBox(i + 1)
    if (e.key === 'Enter') {
      e.preventDefault()
      void submit()
    }
  }

  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6)
    if (!text) return
    e.preventDefault()
    const chars = text.split('')
    setDigits([...chars, ...Array(6 - chars.length).fill('')].slice(0, 6))
    focusBox(Math.min(text.length, 5))
  }

  async function submit() {
    if (submitting || code.length !== 6) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/users/totp/verify', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Invalid code')
      // HARD navigation, deliberately — not router.push()/router.refresh().
      //
      // Completing this step changes the request's AUTHORISATION state: the
      // server has just issued the `bulbau-totp-verified` step-up cookie that
      // src/proxy.ts gates every /admin/* route on. A soft (client-side)
      // navigation reuses the App Router's client cache, which may already hold
      // the RSC payload for /admin fetched BEFORE that cookie existed — and what
      // it holds is proxy.ts's redirect back to /admin/totp-verify. Pushing then
      // replays that cached redirect, so a correct 6-digit code bounces the admin
      // straight back to the code screen, forever. (Reproduced on Next 16.3.4:
      // the verify call returns 200 and sets the cookie, then the /admin RSC
      // request is answered from cache with the old redirect.)
      //
      // `router.refresh()` does not save it either: it invalidates the CURRENT
      // route, and racing it against a push to a different route is exactly the
      // kind of ordering assumption that broke here across a minor upgrade.
      //
      // A full page load throws the entire client cache away and re-runs proxy.ts
      // with the new cookie. It is also what Payload's own login does, so the
      // admin's post-authentication experience is consistent either way. The
      // cost — one full document load, once per login — is irrelevant next to
      // silently locking the only administrator out of the panel.
      //
      // PROOF (request trace captured with router.push in place, Next 16.3.4):
      //   POST /api/users/totp/verify            200, sets the step-up cookie
      //   GET  /admin/totp-verify?_rsc=…         200
      //   …and NO request to /admin at any point.
      // The push was answered entirely from the client Router Cache — the server
      // was never asked — so no server-side change could have fixed it.
      //
      // Next 16.3 added a lint rule against this; its stated rationale is that a
      // hard navigation "loses any prefetched data or state managed by the
      // framework". Here that is precisely the INTENT: the prefetched state was
      // captured under the old authorisation and is now wrong. Next exposes no
      // API to invalidate the whole Router Cache (router.refresh() covers only
      // the current route), so the rule's documented alternative cannot express
      // "my privileges just changed". Suppressed deliberately, with the trace
      // above as the evidence — revisit if Next ever ships cache invalidation.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign('/admin')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid code')
      setDigits(['', '', '', '', '', ''])
      focusBox(0)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form
      className="amfa-form"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <div className="amfa-otp" role="group" aria-label="6-digit authentication code">
        {digits.map((d, i) => (
          <input
            key={i}
            ref={(el) => {
              refs.current[i] = el
            }}
            className="amfa-otp__box"
            type="text"
            inputMode="numeric"
            autoComplete={i === 0 ? 'one-time-code' : 'off'}
            maxLength={1}
            value={d}
            aria-label={`Digit ${i + 1}`}
            aria-invalid={error ? true : undefined}
            autoFocus={i === 0}
            onChange={(e) => setDigit(i, e.target.value)}
            onKeyDown={(e) => onKeyDown(i, e)}
            onPaste={onPaste}
          />
        ))}
      </div>
      {error && (
        <p className="amfa-error" role="alert">
          {error}
        </p>
      )}
      <button className="amfa-btn" type="submit" disabled={submitting || code.length !== 6}>
        {submitting ? 'Verifying…' : 'Verify & sign in'}
      </button>
    </form>
  )
}
