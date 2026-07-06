'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

/**
 * Client half of the /admin/totp-verify view — the per-login second-factor
 * prompt. Calls POST /api/users/totp/verify (see
 * src/collections/Users.endpoints.ts), which on success sets the step-up
 * cookie that src/access/requireTotpVerified.ts checks for every other
 * admin operation.
 */
export function TotpVerifyForm() {
  const router = useRouter()
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
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
      setCode('')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <label htmlFor="totp-verify-code">Enter the 6-digit code from your authenticator app</label>
      <input
        id="totp-verify-code"
        name="code"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6}"
        maxLength={6}
        required
        autoFocus
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
      />
      {error && <p style={{ color: 'var(--theme-error-500, #d00)' }}>{error}</p>}
      <button type="submit" disabled={submitting || code.length !== 6}>
        {submitting ? 'Verifying…' : 'Verify'}
      </button>
    </form>
  )
}
