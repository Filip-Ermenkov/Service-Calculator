'use client'

import { useState } from 'react'
import { toast, useListQuery } from '@payloadcms/ui'

/**
 * Client half of HomeCardLimitSettings: the "Number of service cards shown on
 * Home page" select and its Save button. `0` = show all published services.
 *
 * The option list runs 1…N where N is the live service count from the list
 * query, so the choices always match what exists. Saving posts to
 * /api/admin/services (`setLimit`), which re-checks the session + TOTP step-up
 * itself and writes the `home-settings` global — that write fires the standard
 * revalidate hook, so the Home page updates within seconds.
 */
export const HomeCardLimitForm = ({ initialLimit }: { initialLimit: number }) => {
  const { data } = useListQuery()
  const total = data?.totalDocs ?? 0

  const [limit, setLimit] = useState<number>(initialLimit)
  const [savedLimit, setSavedLimit] = useState<number>(initialLimit)
  const [busy, setBusy] = useState(false)

  async function save() {
    if (busy) return
    setBusy(true)
    try {
      const res = await fetch('/api/admin/services', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action: 'setLimit', limit }),
      })
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean }
      if (res.ok && json.ok === true) {
        setSavedLimit(limit)
        toast.success('Setting saved — the Home page updates within seconds.')
      } else {
        toast.error('Could not save the setting.')
      }
    } catch {
      toast.error('Could not save the setting. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="alist-settings" aria-labelledby="alist-settings-title">
      <h2 className="alist-settings__label" id="alist-settings-title">
        Home Page Display Settings
      </h2>
      <div className="alist-settings__row">
        <div className="alist-field">
          <label className="alist-field__label" htmlFor="alist-limit">
            Number of service cards shown on Home page
          </label>
          <select
            id="alist-limit"
            className="alist-select"
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
          >
            <option value={0}>All services{total ? ` (${total})` : ''}</option>
            {Array.from({ length: total }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n} {n === 1 ? 'card' : 'cards'}
                {n === total ? ' (all)' : ''}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          className="alist-save"
          disabled={busy || limit === savedLimit}
          onClick={save}
        >
          Save Setting
        </button>
      </div>
    </section>
  )
}
