'use client'

import React, { useState } from 'react'

/**
 * Client half of the Services management screen (rendered by ServicesView).
 * Presents the prototype's /prototype/admin/services table — drag-to-reorder
 * (persisted as the Home-page card order), inline Edit / Preview / Delete, and
 * the Home-page "number of cards" setting. All mutations POST to
 * /api/admin/services, which enforces the session + TOTP step-up boundary.
 */

export type ServiceRow = {
  id: string | number
  title: string
  slug: string
  edited: string
  homeCard: string
  fieldCount: number
  status: 'published' | 'draft'
}

type Props = {
  rows: ServiceRow[]
  adminRoute: string
  previewBase: string
  limit: number
}

const InfoIcon = () => (
  <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
  </svg>
)
const GripIcon = () => (
  <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
    <line x1="9" y1="5" x2="9" y2="19" /><line x1="15" y1="5" x2="15" y2="19" />
  </svg>
)
const PlusIcon = () => (
  <svg width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24" aria-hidden="true">
    <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
  </svg>
)

async function post(body: Record<string, unknown>): Promise<boolean> {
  try {
    const r = await fetch('/api/admin/services', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    })
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean }
    return r.ok && j.ok === true
  } catch {
    return false
  }
}

export function ServicesManager({ rows: initialRows, adminRoute, previewBase, limit: initialLimit }: Props) {
  const a = adminRoute.replace(/\/$/, '')
  const [rows, setRows] = useState<ServiceRow[]>(initialRows)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)
  const [confirmId, setConfirmId] = useState<string | number | null>(null)
  const [limit, setLimit] = useState<number>(initialLimit)
  const [savedLimit, setSavedLimit] = useState<number>(initialLimit)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null)

  const total = rows.length

  function flash(text: string, ok: boolean) {
    setMsg({ text, ok })
    window.setTimeout(() => setMsg(null), 3500)
  }

  async function commitOrder(next: ServiceRow[]) {
    const prev = rows
    setRows(next)
    setBusy(true)
    const ok = await post({ action: 'reorder', ids: next.map((r) => r.id) })
    setBusy(false)
    if (ok) flash('Order saved.', true)
    else {
      setRows(prev)
      flash('Could not save the new order.', false)
    }
  }

  function onDrop(target: number) {
    setOverIndex(null)
    if (dragIndex === null || dragIndex === target) return
    const next = [...rows]
    const [moved] = next.splice(dragIndex, 1)
    next.splice(target, 0, moved)
    setDragIndex(null)
    void commitOrder(next)
  }

  async function doDelete(id: string | number) {
    setBusy(true)
    const ok = await post({ action: 'delete', id })
    setBusy(false)
    setConfirmId(null)
    if (ok) {
      setRows(rows.filter((r) => r.id !== id))
      flash('Service deleted.', true)
    } else flash('Delete failed.', false)
  }

  async function saveLimit() {
    setBusy(true)
    const ok = await post({ action: 'setLimit', limit })
    setBusy(false)
    if (ok) setSavedLimit(limit)
    flash(ok ? 'Setting saved.' : 'Could not save setting.', ok)
  }

  return (
    <div className="asvc">
      <div className="asvc-top">
        <h1 className="asvc-pagetitle">Services</h1>
        <a className="asvc-new" href={`${a}/collections/services/create`}>
          <PlusIcon /> New Service
        </a>
      </div>

      <div className="asvc-banner">
        <InfoIcon />
        <span>The order shown here determines the order of service cards on the Home page. Drag rows to reorder.</span>
      </div>

      <section className="asvc-card">
        <div className="asvc-cardhead">
          <h2 className="asvc-cardtitle">All Services ({total})</h2>
          {total > 1 ? <span className="asvc-hint">Drag rows to reorder</span> : null}
        </div>

        {total === 0 ? (
          <p className="asvc-empty">No services yet. Use “New Service” to create one.</p>
        ) : (
          <table className="asvc-table">
            <thead>
              <tr>
                <th className="asvc-th-handle" aria-label="Reorder" />
                <th>Service</th>
                <th>Home Page Card</th>
                <th>Calculator Fields</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={r.id}
                  className={overIndex === i && dragIndex !== null ? 'asvc-row asvc-row--over' : 'asvc-row'}
                  onDragOver={(e) => {
                    if (dragIndex === null) return
                    e.preventDefault()
                    if (overIndex !== i) setOverIndex(i)
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    onDrop(i)
                  }}
                >
                  <td
                    className="asvc-handle"
                    draggable
                    onDragStart={(e) => {
                      setDragIndex(i)
                      e.dataTransfer.effectAllowed = 'move'
                      e.dataTransfer.setData('text/plain', String(r.id))
                    }}
                    onDragEnd={() => {
                      setDragIndex(null)
                      setOverIndex(null)
                    }}
                    title="Drag to reorder"
                    aria-label="Drag to reorder"
                  >
                    <GripIcon />
                  </td>
                  <td data-label="Service" data-primary>
                    <strong className="asvc-name">{r.title}</strong>
                    <div className="asvc-sub">{r.edited}</div>
                  </td>
                  <td className="asvc-meta" data-label="Home Page Card">{r.homeCard}</td>
                  <td className="asvc-meta" data-label="Calculator Fields">
                    {r.fieldCount} {r.fieldCount === 1 ? 'field' : 'fields'} defined
                    {r.status === 'draft' ? <span className="asvc-draftflag"> · Draft</span> : null}
                  </td>
                  <td data-label="Status">
                    <span className={`asvc-badge asvc-badge--${r.status}`}>
                      {r.status === 'draft' ? 'Draft' : 'Published'}
                    </span>
                  </td>
                  <td data-label="Actions">
                    {confirmId === r.id ? (
                      <div className="asvc-actions">
                        <span className="asvc-confirm">Delete “{r.title}”?</span>
                        <button className="asvc-link asvc-link--red" disabled={busy} onClick={() => doDelete(r.id)}>
                          Confirm
                        </button>
                        <span className="asvc-sep">·</span>
                        <button className="asvc-link asvc-link--gray" disabled={busy} onClick={() => setConfirmId(null)}>
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <div className="asvc-actions">
                        <a className="asvc-link" href={`${a}/collections/services/${r.id}`}>
                          Edit
                        </a>
                        <span className="asvc-sep">·</span>
                        <a
                          className="asvc-link asvc-link--gray"
                          href={`${previewBase}/services/${r.slug}`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Preview
                        </a>
                        <span className="asvc-sep">·</span>
                        <button className="asvc-link asvc-link--red" onClick={() => setConfirmId(r.id)}>
                          Delete
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="asvc-card asvc-settings">
        <div className="asvc-settings__label">Home Page Display Settings</div>
        <div className="asvc-settings__row">
          <div className="asvc-field">
            <label className="asvc-field__label" htmlFor="asvc-limit">
              Number of service cards shown on Home page
            </label>
            <select
              id="asvc-limit"
              className="asvc-select"
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
          <button className="asvc-save" disabled={busy || limit === savedLimit} onClick={saveLimit}>
            Save Setting
          </button>
        </div>
      </section>

      {msg ? <div className={msg.ok ? 'asvc-toast asvc-toast--ok' : 'asvc-toast asvc-toast--err'}>{msg.text}</div> : null}
    </div>
  )
}
