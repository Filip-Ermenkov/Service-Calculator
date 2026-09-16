'use client'

/**
 * The reorder hint banner from the prototype's Services screen
 * (/prototype/admin/services.html), generalised for every drag-orderable list.
 * Registered per collection as the first `beforeListTable` component, so it
 * sits between Payload's list controls and the "All X (n)" card header.
 *
 * It says what the drag order MEANS for that collection — which public surface
 * follows it — because a drag handle with no stated consequence is a mystery
 * control. Collections without an entry render nothing.
 */

import { useListQuery } from '@payloadcms/ui'

const BANNERS: Record<string, string> = {
  services:
    'The order shown here determines the order of the service cards on the Home page. Drag rows to reorder.',
  projects:
    'The order shown here is the order of the projects on the public Projects page — a new project is added at the top. Drag rows to reorder.',
  'career-listings':
    'The order shown here is the order of the listings on the public Careers page. Drag rows to reorder.',
}

const InfoIcon = () => (
  <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="8" x2="12" y2="12" />
    <line x1="12" y1="16" x2="12.01" y2="16" />
  </svg>
)

export const ListOrderBanner = () => {
  const { collectionSlug } = useListQuery()
  const text = collectionSlug ? BANNERS[collectionSlug] : undefined
  if (!text) return null

  return (
    <div className="alist-banner" role="note">
      <InfoIcon />
      <span>{text}</span>
    </div>
  )
}
