'use client'

/**
 * The card header the prototype puts above every admin list table — "All
 * Projects (8)", "All Services (3)" (/prototype/admin/*.html). Registered per
 * collection as a `beforeListTable` component, so it sits directly on top of
 * Payload's own table and turns it into the prototype's titled card.
 *
 * The count is the live `totalDocs` from the list query, so it tracks search
 * and filters rather than claiming a stale total. Drag-orderable collections
 * (Payload's `orderable: true`) get the prototype's "Drag rows to reorder" hint
 * on the right — but only while the list is actually sorted by the order key,
 * because that is the only state in which Payload shows the drag handles.
 */

import { useConfig, useListQuery } from '@payloadcms/ui'

function pluralLabel(label: unknown, fallback: string): string {
  if (typeof label === 'string') return label
  // Payload allows a per-language record; EN is this admin's only language.
  if (label && typeof label === 'object' && 'en' in label) {
    const en = (label as { en?: unknown }).en
    if (typeof en === 'string') return en
  }
  return fallback
}

export const ListCardHeader = () => {
  const { collectionSlug, data, query } = useListQuery()
  const { getEntityConfig } = useConfig()

  const config = collectionSlug ? getEntityConfig({ collectionSlug }) : undefined
  const plural = pluralLabel(config?.labels?.plural, collectionSlug ?? 'Documents')
  const total = data?.totalDocs ?? 0

  const sort = typeof query?.sort === 'string' ? query.sort : undefined
  const orderable = Boolean((config as { orderable?: boolean } | undefined)?.orderable)
  const showDragHint = orderable && total > 1 && (sort === undefined || sort === '_order' || sort === '-_order')

  return (
    <div className="alist-head">
      <h2 className="alist-head__title">
        All {plural} ({total})
      </h2>
      {showDragHint ? <span className="alist-head__hint">Drag rows to reorder</span> : null}
    </div>
  )
}
