'use client'

import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'

/**
 * Client half of /admin/totp-verify — the per-login second-factor prompt.
 * Six single-character boxes (matching the prototype) with auto-advance,
 * backspace-to-previous, and paste-to-fill; the joined value is posted to
 * POST /api/users/totp/verify (see src/collections/Users.endpoints.ts).
 */
export function TotpVerifyForm() {
  const router = useRouter()
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
      router.push('/admin')
      router.refresh()
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
