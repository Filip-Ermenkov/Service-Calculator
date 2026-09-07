'use client'

import { SetStepNav } from '@payloadcms/ui'
import { useMemo } from 'react'

/**
 * Publishes a page's breadcrumb trail to Payload's StepNav context, which the
 * app header renders — and which `custom.scss` styles as the prototype's
 * `.admin-topbar` page title (the last crumb big and orange-barred, its
 * ancestors as a small trail on wide screens).
 *
 * Payload sets that trail itself on every built-in view (collection lists,
 * document editors, account), but a custom Root View — the dashboard, Services
 * and Translations screens here — has to set its own, or the top bar would show
 * no title at all. This component is that one line of wiring.
 *
 * Client component because StepNav lives in a React context; the custom views
 * that use it are server components, which can render it as a child.
 *
 * `SetStepNav` re-runs its effect whenever the `nav` array's identity changes,
 * so the array is memoised on the values it is built from rather than rebuilt
 * inline on every render.
 */
export function AdminPageTitle({
  title,
  parent,
}: {
  /** The current page — rendered as the page title. */
  title: string
  /** Optional ancestor shown before it, e.g. Services → Photovoltaic Systems. */
  parent?: { label: string; url: string }
}) {
  const parentLabel = parent?.label
  const parentUrl = parent?.url

  const nav = useMemo(
    () =>
      parentLabel
        ? [{ label: parentLabel, url: parentUrl }, { label: title }]
        : [{ label: title }],
    [title, parentLabel, parentUrl],
  )

  return <SetStepNav nav={nav} />
}

export default AdminPageTitle
