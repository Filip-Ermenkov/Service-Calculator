'use client'

/**
 * The prototype's per-row "Actions" column (/prototype/admin/projects.html,
 * /prototype/admin/careers.html): Edit · [Archive|Restore] · Delete, with the
 * destructive action asking for confirmation inline rather than in a modal —
 * the same pattern as the custom Services screen (ServicesManager.tsx).
 *
 * Wired as the `Cell` of a list-only `ui` field, so Payload's native list keeps
 * its search, sorting, pagination and column controls; only the extra column is
 * ours. Every mutation goes through Payload's own REST endpoint for the
 * collection, so the collection's access control — including the TOTP step-up
 * gate (src/access/requireTotpVerified.ts) — is enforced exactly as it is for
 * the document editor. Nothing here bypasses it.
 *
 * Archive/Restore only appears for a collection that actually has an
 * active/archived `status` field (careers); everything else gets Edit · Delete.
 */

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast, useConfig } from '@payloadcms/ui'

type Row = {
  id?: number | string
  status?: string
  title?: string
}

export const RowActionsCell = ({
  collectionSlug,
  rowData,
}: {
  collectionSlug?: string
  rowData?: Row
}) => {
  const router = useRouter()
  const {
    config: {
      routes: { admin, api },
      serverURL,
    },
  } = useConfig()

  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const id = rowData?.id
  if (id === undefined || id === null || !collectionSlug) return null

  const endpoint = `${serverURL}${api}/${collectionSlug}/${id}`
  const isArchived = rowData?.status === 'archived'
  const canArchive = rowData?.status === 'active' || isArchived

  async function send(
    method: 'DELETE' | 'PATCH',
    body: unknown,
    okMessage: string,
    failMessage: string,
  ) {
    if (busy) return
    setBusy(true)
    try {
      const res = await fetch(endpoint, {
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'include',
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        method,
      })
      if (res.ok) {
        toast.success(okMessage)
        // Re-run the list's server component so the row disappears / re-badges.
        router.refresh()
      } else {
        toast.error(failMessage)
      }
    } catch {
      toast.error(failMessage)
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  if (confirming) {
    return (
      <div className="arow">
        <span className="arow__confirm">Delete{rowData?.title ? ` “${rowData.title}”` : ''}?</span>
        <button
          className="arow__link arow__link--red"
          disabled={busy}
          onClick={() => void send('DELETE', undefined, 'Deleted.', 'Could not delete it.')}
          type="button"
        >
          Confirm
        </button>
        <span className="arow__sep">·</span>
        <button
          className="arow__link arow__link--gray"
          disabled={busy}
          onClick={() => setConfirming(false)}
          type="button"
        >
          Cancel
        </button>
      </div>
    )
  }

  return (
    <div className="arow">
      <Link className="arow__link" href={`${admin}/collections/${collectionSlug}/${id}`}>
        Edit
      </Link>
      {canArchive ? (
        <>
          <span className="arow__sep">·</span>
          <button
            className={`arow__link${isArchived ? '' : ' arow__link--gray'}`}
            disabled={busy}
            onClick={() =>
              void send(
                'PATCH',
                { status: isArchived ? 'active' : 'archived' },
                isArchived ? 'Restored — visible on the website again.' : 'Archived — hidden from the website.',
                'Could not change the status.',
              )
            }
            type="button"
          >
            {isArchived ? 'Restore' : 'Archive'}
          </button>
        </>
      ) : null}
      <span className="arow__sep">·</span>
      <button
        className="arow__link arow__link--red"
        onClick={() => setConfirming(true)}
        type="button"
      >
        Delete
      </button>
    </div>
  )
}
