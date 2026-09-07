'use client'

/**
 * The card header the prototype puts above every admin list table — "All
 * Projects (8)", "Job Openings (3)" (/prototype/admin/projects.html,
 * /prototype/admin/careers.html). Registered per collection as a
 * `beforeListTable` component, so it sits directly on top of Payload's own
 * table and turns it into the prototype's titled card.
 *
 * The count is the live `totalDocs` from the list query, so it tracks search
 * and filters rather than claiming a stale total.
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
  const { collectionSlug, data } = useListQuery()
  const { getEntityConfig } = useConfig()

  const config = collectionSlug ? getEntityConfig({ collectionSlug }) : undefined
  const plural = pluralLabel(config?.labels?.plural, collectionSlug ?? 'Documents')
  const total = data?.totalDocs ?? 0

  return (
    <div className="alist-head">
      <h2 className="alist-head__title">
        All {plural} ({total})
      </h2>
    </div>
  )
}
