'use client'

import { useState, type FormEvent } from 'react'
import { toast, useAuth, useDocumentInfo } from '@payloadcms/ui'

/**
 * The admin-assisted 2FA reset control, rendered at the top of a user's edit
 * screen (the `totpAdminReset` ui field on the Users collection).
 *
 * This is the UI half of /api/users/totp/admin-reset — see the long note on
 * that endpoint for why the feature exists. The short version: nothing else in
 * the product can clear someone's lost authenticator, so without this the
 * recovery procedure was hand-written SQL against production.
 *
 * The endpoint, not this component, is the security boundary. Everything here
 * is about making the right thing easy at the moment it is needed:
 *   • it hides on the create form (no user yet) and on your own account, where
 *     the Account screen's own 2FA controls are the correct path;
 *   • it keeps the password field behind an explicit first click, so the
 *     destructive action is never one stray click away;
 *   • it says plainly what will happen to the other person, because the
 *     operator is usually doing this while someone is on the phone.
 */
export const TotpAdminReset = () => {
  const { id } = useDocumentInfo()
  const { user } = useAuth()

  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // No document yet (create form) — there is nothing to reset.
  if (!id) return null
  // Your own account: /totp/disable is the right path and proves you still
  // hold the current device. Offering this here would be the weaker route.
  if (user && String(user.id) === String(id)) return null

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/users/totp/admin-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ userId: id, currentPassword: password }),
      })
      const json = (await res.json().catch(() => ({}))) as {
        success?: boolean
        hadTotp?: boolean
        error?: string
      }
      if (res.ok && json.success) {
        setOpen(false)
        setPassword('')
        toast.success(
          json.hadTotp
            ? 'Two-factor authentication reset. They will be asked to set it up again at their next login.'
            : 'This account already had no two-factor authentication set up. Nothing to reset.',
        )
      } else {
        setError(json.error ?? 'Could not reset two-factor authentication.')
      }
    } catch {
      setError('Could not reach the server. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="atfa" aria-labelledby="atfa-title">
      <h4 className="atfa__title" id="atfa-title">
        Two-factor authentication
      </h4>
      <div className="anote">
        If this person has lost the phone or app holding their authenticator, reset it here.
        They keep their password, and the next time they log in they will be asked to set up
        two-factor authentication again from scratch. Until they do, they cannot reach anything
        in this panel. You will need your own password to confirm.
      </div>

      {!open ? (
        <button type="button" className="atfa__btn" onClick={() => setOpen(true)}>
          Reset two-factor authentication
        </button>
      ) : (
        <form className="atfa__form" onSubmit={submit}>
          <label className="atfa__label" htmlFor="atfa-password">
            Your password
          </label>
          <input
            id="atfa-password"
            className="atfa__input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
            required
          />
          {error ? (
            <p className="atfa__error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="atfa__actions">
            <button type="submit" className="atfa__btn" disabled={busy || password === ''}>
              {busy ? 'Resetting…' : 'Confirm reset'}
            </button>
            <button
              type="button"
              className="atfa__btn atfa__btn--ghost"
              disabled={busy}
              onClick={() => {
                setOpen(false)
                setPassword('')
                setError(null)
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  )
}
