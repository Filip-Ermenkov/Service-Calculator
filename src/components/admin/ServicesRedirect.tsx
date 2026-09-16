import { redirect } from 'next/navigation'

/**
 * `/admin/services` → `/admin/collections/services`.
 *
 * Until 2026-09-14 the Services screen was a bespoke Root View at this path
 * (ServicesView + ServicesManager). It was replaced by Payload's native list —
 * restyled to the same design and carrying the same extras through list slots
 * (order banner, summary columns, the Home-page card-count setting) — so every
 * collection list behaves identically: bulk selection, search, pagination and
 * keyboard-accessible drag ordering from the platform. This stub keeps the old
 * bookmark/nav path alive instead of 404ing it.
 */
export default function ServicesRedirect() {
  redirect('/admin/collections/services')
}
