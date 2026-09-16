'use client'

/**
 * The record's identity cell in every admin list — the prototype's Services
 * table row head (/prototype/admin/services.html): the title as a bold link to
 * the editor, with "Last edited: yesterday" as a quiet sub-line underneath.
 *
 * Registered as the `Cell` of each collection's `useAsTitle` field (services,
 * projects, career listings). It keeps Payload's own contract for that cell —
 * the title links to `/admin/collections/<slug>/<id>` exactly as the default
 * cell does — and only adds the sub-line, so the column stays sortable and
 * searchable through Payload's list controls.
 */

import Link from 'next/link'
import type { DefaultCellComponentProps } from 'payload'
import { useConfig } from '@payloadcms/ui'

import { relativeEdited } from './relativeEdited'

export const TitleCell = ({
  cellData,
  collectionSlug,
  rowData,
}: DefaultCellComponentProps) => {
  const {
    config: {
      routes: { admin },
    },
  } = useConfig()

  const id = rowData?.id
  const title =
    (typeof cellData === 'string' && cellData.trim().length > 0 && cellData) ||
    (id !== undefined ? `#${String(id)}` : '—')
  const updatedAt = (rowData as { updatedAt?: string } | undefined)?.updatedAt

  return (
    <div className="acell-title">
      {id !== undefined ? (
        <Link
          className="acell-title__link"
          href={`${admin}/collections/${collectionSlug}/${encodeURIComponent(String(id))}`}
          prefetch={false}
        >
          {title}
        </Link>
      ) : (
        <span className="acell-title__link">{title}</span>
      )}
      <div className="acell-sub">{relativeEdited(updatedAt)}</div>
    </div>
  )
}
