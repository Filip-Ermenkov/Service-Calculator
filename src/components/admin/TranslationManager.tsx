'use client'

import { useMemo, useState } from 'react'

import {
  deriveStatus,
  TARGET_LOCALES,
  type InventoryStats,
  type LeafStatus,
  type TargetLocaleCode,
  type TranslationEntry,
} from '@/lib/translation/inventory'

import './TranslationManager.scss'

/**
 * Translation Management table (Phase 5 part 2, FUNCTIONALITY.md §5.7) — the
 * interactive client half of the admin Translation Management screen. The server
 * view (TranslationsView.tsx) supplies the flattened inventory; this component
 * lets the admin search/filter it, edit a plain-text override inline, re-generate
 * a machine translation, and (for rich text) jump to the native localized editor.
 *
 * Writes go to POST /api/admin/translations. On success the row's local state is
 * updated and its status re-derived, so the table reflects the change without a
 * full reload.
 */

const LOCALE_LABEL: Record<TargetLocaleCode, string> = { fr: 'Français', de: 'Deutsch' }

const baseClass = 'translation-manager'

type EntityFilter = 'all' | string

export function TranslationManager({
  entries: initialEntries,
  stats,
  adminRoute,
}: {
  entries: TranslationEntry[]
  stats: InventoryStats
  adminRoute: string
}) {
  const [entries, setEntries] = useState<TranslationEntry[]>(initialEntries)
  const [query, setQuery] = useState('')
  const [entityFilter, setEntityFilter] = useState<EntityFilter>('all')
  const [onlyNeedsAttention, setOnlyNeedsAttention] = useState(false)

  const entities = useMemo(() => {
    const set = new Map<string, string>()
    for (const e of initialEntries) if (!set.has(e.entity)) set.set(e.entity, e.entity)
    return Array.from(set.keys())
  }, [initialEntries])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return entries.filter((e) => {
      if (entityFilter !== 'all' && e.entity !== entityFilter) return false
      if (onlyNeedsAttention) {
        const needs = TARGET_LOCALES.some((l) => e.targets[l].status === 'untranslated')
        if (!needs) return false
      }
      if (q) {
        const hay = [
          e.docLabel,
          e.fieldLabel,
          e.en,
          e.targets.fr.value,
          e.targets.de.value,
        ]
          .join('  ')
          .toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [entries, query, entityFilter, onlyNeedsAttention])

  const applyResult = (entryId: string, locale: TargetLocaleCode, value: string) => {
    setEntries((prev) =>
      prev.map((e) => {
        if (e.id !== entryId) return e
        return {
          ...e,
          targets: {
            ...e.targets,
            [locale]: { value, status: deriveStatus(e.en, value) },
          },
        }
      }),
    )
  }

  return (
    <div className={baseClass}>
      <header className={`${baseClass}__header`}>
        <h1>Translation Management</h1>
        <p className={`${baseClass}__intro`}>
          Review and correct the French and German translations of your content. Content is written
          in English and translated automatically; anything below that still shows the English text
          (marked <span className="pill pill--untranslated">Needs translation</span>) has not been
          translated yet. Editing a value here saves it as a manual override that takes effect
          immediately.
        </p>
        <p className={`${baseClass}__summary`}>
          {stats.total} translatable {stats.total === 1 ? 'string' : 'strings'} ·{' '}
          <strong>{stats.untranslated.fr}</strong> need French ·{' '}
          <strong>{stats.untranslated.de}</strong> need German
        </p>
      </header>

      <div className={`${baseClass}__controls`}>
        <input
          type="search"
          className={`${baseClass}__search`}
          placeholder="Search content, field, or translation…"
          value={query}
          aria-label="Search translations"
          onChange={(ev) => setQuery(ev.target.value)}
        />
        <label className={`${baseClass}__filter`}>
          <span>Content type</span>
          <select value={entityFilter} onChange={(ev) => setEntityFilter(ev.target.value)}>
            <option value="all">All</option>
            {entities.map((slug) => (
              <option key={slug} value={slug}>
                {slug}
              </option>
            ))}
          </select>
        </label>
        <label className={`${baseClass}__attention`}>
          <input
            type="checkbox"
            checked={onlyNeedsAttention}
            onChange={(ev) => setOnlyNeedsAttention(ev.target.checked)}
          />
          <span>Only needs translation</span>
        </label>
      </div>

      {filtered.length === 0 ? (
        <p className={`${baseClass}__empty`}>No strings match your search.</p>
      ) : (
        <table className={`${baseClass}__table`}>
          <thead>
            <tr>
              <th scope="col">Content</th>
              <th scope="col">English (source)</th>
              {TARGET_LOCALES.map((l) => (
                <th key={l} scope="col">
                  {LOCALE_LABEL[l]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((entry) => (
              <tr key={entry.id}>
                <td className={`${baseClass}__source`}>
                  <span className={`${baseClass}__doc`}>{entry.docLabel}</span>
                  <span className={`${baseClass}__field`}>
                    {entry.fieldLabel}
                    {entry.leafCount > 1 ? ` #${entry.leafIndex + 1}` : ''}
                  </span>
                  {entry.type === 'richText' && (
                    <span className="pill pill--richtext">Rich text</span>
                  )}
                </td>
                <td className={`${baseClass}__en`}>{entry.en || <em>(empty)</em>}</td>
                {TARGET_LOCALES.map((locale) => (
                  <td key={locale} className={`${baseClass}__target`}>
                    <TargetCell
                      entry={entry}
                      locale={locale}
                      adminRoute={adminRoute}
                      onSaved={(value) => applyResult(entry.id, locale, value)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function editHref(entry: TranslationEntry, locale: TargetLocaleCode, adminRoute: string): string {
  const base = adminRoute.replace(/\/$/, '')
  if (entry.isGlobal) return `${base}/globals/${entry.entity}?locale=${locale}`
  return `${base}/collections/${entry.entity}/${String(entry.docId)}?locale=${locale}`
}

function StatusPill({ status }: { status: LeafStatus }) {
  if (status === 'translated') return <span className="pill pill--translated">Translated</span>
  if (status === 'empty') return <span className="pill pill--empty">No source</span>
  return <span className="pill pill--untranslated">Needs translation</span>
}

function TargetCell({
  entry,
  locale,
  adminRoute,
  onSaved,
}: {
  entry: TranslationEntry
  locale: TargetLocaleCode
  adminRoute: string
  onSaved: (value: string) => void
}) {
  const target = entry.targets[locale]
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(target.value)
  const [busy, setBusy] = useState<null | 'save' | 'retranslate'>(null)
  const [error, setError] = useState<string | null>(null)

  const isRichText = entry.type === 'richText'

  const post = async (action: 'save' | 'retranslate', value?: string) => {
    setBusy(action)
    setError(null)
    try {
      const res = await fetch('/api/admin/translations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          entity: entry.entity,
          isGlobal: entry.isGlobal,
          docId: entry.docId,
          registryPath: entry.registryPath,
          leafIndex: entry.leafIndex,
          locale,
          action,
          value,
        }),
      })
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; value?: string; error?: string }
      if (!res.ok || !data.ok) {
        setError(messageFor(data.error, res.status))
        return
      }
      onSaved(typeof data.value === 'string' ? data.value : (value ?? ''))
      setDraft(typeof data.value === 'string' ? data.value : (value ?? ''))
      setEditing(false)
    } catch {
      setError('Network error — please try again.')
    } finally {
      setBusy(null)
    }
  }

  // Rich text: show a read-only preview + a deep-link to the native editor.
  if (isRichText) {
    return (
      <div className="tcell">
        <div className="tcell__value">
          {target.value ? <span>{target.value}</span> : <em className="tcell__placeholder">—</em>}
        </div>
        <div className="tcell__row">
          <StatusPill status={target.status} />
          <a className="tcell__link" href={editHref(entry, locale, adminRoute)}>
            Edit in editor →
          </a>
        </div>
      </div>
    )
  }

  if (editing) {
    return (
      <div className="tcell tcell--editing">
        <textarea
          className="tcell__textarea"
          value={draft}
          aria-label={`${LOCALE_LABEL[locale]} translation for ${entry.fieldLabel}`}
          onChange={(ev) => setDraft(ev.target.value)}
          rows={Math.min(6, Math.max(2, Math.ceil(draft.length / 40)))}
        />
        {error && (
          <p className="tcell__error" role="alert">
            {error}
          </p>
        )}
        <div className="tcell__actions">
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy !== null}
            onClick={() => post('save', draft)}
          >
            {busy === 'save' ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            onClick={() => {
              setDraft(target.value)
              setError(null)
              setEditing(false)
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="tcell">
      <div className="tcell__value">
        {target.value ? <span>{target.value}</span> : <em className="tcell__placeholder">—</em>}
      </div>
      <div className="tcell__row">
        <StatusPill status={target.status} />
      </div>
      {error && (
        <p className="tcell__error" role="alert">
          {error}
        </p>
      )}
      <div className="tcell__actions">
        <button
          type="button"
          className="btn"
          disabled={busy !== null}
          onClick={() => {
            setDraft(target.value)
            setEditing(true)
          }}
        >
          Edit
        </button>
        <button
          type="button"
          className="btn btn--ghost"
          disabled={busy !== null || entry.en.trim().length === 0}
          title="Replace with a fresh machine translation of the English source"
          onClick={() => post('retranslate')}
        >
          {busy === 'retranslate' ? 'Translating…' : 'Re-translate'}
        </button>
      </div>
    </div>
  )
}

function messageFor(error: string | undefined, status: number): string {
  switch (error) {
    case 'translation_not_configured':
      return 'Automatic translation is not enabled on this environment.'
    case 'empty_source':
      return 'There is no English text to translate.'
    case 'translation_failed':
      return 'Translation service is unavailable — try again shortly.'
    case 'step_up_required':
      return 'Your two-factor session expired — reload the admin and sign in again.'
    case 'unauthenticated':
      return 'You are signed out — reload the admin and sign in again.'
    case 'not_plain_text':
      return 'This field is edited in the document editor.'
    default:
      return `Could not save (error ${status}).`
  }
}
