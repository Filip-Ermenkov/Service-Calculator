'use client'

/**
 * The Published / Draft select the prototype shows beside a document's title
 * (/prototype/admin/service-editor.html, /prototype/admin/projects.html).
 * Collection-agnostic: drop it into any drafts-enabled collection as a `ui`
 * field — it reads the collection from the surrounding document context.
 *
 * Payload does not store publish state as an ordinary field: `_status` is a
 * submit-time override used by its own Publish / Save Draft / Unpublish
 * controls. So this is a `ui` field that performs exactly those two operations
 * (nothing bespoke, nothing that bypasses access control):
 *
 *   • → Published  = Payload's Publish button — submits the form with
 *                    `_status: 'published'` through the normal REST endpoint.
 *   • → Draft      = Payload's Unpublish action — PATCHes `{_status:'draft'}`,
 *                    which takes the document off the public site (its content
 *                    is kept as a draft).
 *
 * Payload's own Save Draft / Publish buttons in the top bar are untouched and
 * remain the way to save edits; this control only changes visibility.
 */

import React, { useState } from 'react'
import { toast, useConfig, useDocumentInfo, useForm, useLocale } from '@payloadcms/ui'

type Status = 'draft' | 'published'

export const PublishStatusField = () => {
  const {
    id,
    collectionSlug,
    hasPublishedDoc,
    incrementVersionCount,
    setHasPublishedDoc,
    setMostRecentVersionIsAutosaved,
    setUnpublishedVersionCount,
  } = useDocumentInfo()
  const { submit } = useForm()
  const {
    config: {
      routes: { api },
      serverURL,
    },
  } = useConfig()
  const { code: locale } = useLocale()

  const [busy, setBusy] = useState(false)

  const current: Status = hasPublishedDoc ? 'published' : 'draft'
  const isNew = !id

  async function change(next: Status) {
    if (busy || next === current) return
    setBusy(true)
    try {
      if (next === 'published') {
        // Identical to pressing "Publish": validates, saves the current form
        // state and flips the document live.
        const result = await submit({ overrides: { _status: 'published' } })
        if (result) {
          setHasPublishedDoc(true)
          setUnpublishedVersionCount(0)
          setMostRecentVersionIsAutosaved(false)
        }
        return
      }

      // Identical to Payload's "Unpublish": the saved content stays, the public
      // site stops showing it. Deliberately does NOT submit the form, so an
      // unsaved edit is never published as a side effect of hiding the service.
      const query = `?depth=0&fallback-locale=null&locale=${locale}`
      const res = await fetch(`${serverURL}${api}/${collectionSlug}/${id}${query}`, {
        body: JSON.stringify({ _status: 'draft' }),
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        method: 'PATCH',
      })
      if (res.ok) {
        setHasPublishedDoc(false)
        setUnpublishedVersionCount(1)
        setMostRecentVersionIsAutosaved(false)
        incrementVersionCount()
        toast.success('Moved to Draft — no longer visible on the website.')
      } else {
        toast.error('Could not move this to Draft.')
      }
    } catch {
      toast.error('Could not change the status. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="field-type svc-status"
      style={{ '--field-width': '50%' } as React.CSSProperties}
    >
      <label className="field-label" htmlFor="svc-status">
        Status
      </label>
      <select
        className="svc-status__select"
        disabled={busy || isNew}
        id="svc-status"
        onChange={(e) => void change(e.target.value as Status)}
        value={current}
      >
        <option value="published">Published</option>
        <option value="draft">Draft</option>
      </select>
      <p className="field-description svc-status__hint">
        {isNew
          ? 'Save it first — then you can publish it.'
          : current === 'published'
            ? 'Live on the website. Switching to Draft hides it from visitors.'
            : 'Hidden from visitors. Switching to Published saves and publishes the current edits.'}
      </p>
    </div>
  )
}
