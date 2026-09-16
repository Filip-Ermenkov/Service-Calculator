import { Gutter } from '@payloadcms/ui'
import type { ServerProps } from 'payload'

import { HomeCardLimitForm } from './HomeCardLimitForm'

/**
 * "Home Page Display Settings" — the card under the Services list where the
 * admin chooses how many service cards the public Home page shows
 * (FUNCTIONALITY.md §3.1 / §5.3; the `home-settings` global).
 *
 * Registered as the Services collection's `afterList` component: that slot
 * renders after the table AND its pagination row (whereas `afterListTable`
 * would wedge this card between the two), which is where the prototype puts
 * it. `afterList` sits outside Payload's content Gutter, so the card brings
 * its own to line up with the list above.
 *
 * Server half: reads the current value (the global is public-read, and this
 * slot only renders inside the TOTP-gated admin anyway). The client half
 * (HomeCardLimitForm) owns the select + save, posting to /api/admin/services.
 */
export default async function HomeCardLimitSettings({ payload }: ServerProps) {
  let limit = 0
  try {
    const settings = (await payload.findGlobal({
      slug: 'home-settings' as never,
      depth: 0,
      overrideAccess: true,
    })) as { serviceCardLimit?: unknown }
    if (typeof settings?.serviceCardLimit === 'number') limit = settings.serviceCardLimit
  } catch {
    // Singleton not created yet (first boot before any save) — 0 = show all.
  }

  return (
    <Gutter>
      <HomeCardLimitForm initialLimit={limit} />
    </Gutter>
  )
}
