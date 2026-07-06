import { headers as getHeaders } from 'next/headers'
import { redirect } from 'next/navigation'
import type { Payload } from 'payload'

import { isStepUpVerified } from '@/lib/totp/requestHelpers'

/**
 * Injected via admin.components.beforeDashboard (see payload.config.ts) —
 * an additive Root Component slot, not a full view replacement, which is
 * why this is the low-risk place to put the "have you done TOTP yet?"
 * redirect gate rather than trying to fork Payload's own Dashboard view.
 *
 * `beforeDashboard` components aren't given `initPageResult`/`req` (that's
 * specific to full Views — see TotpSetupView.tsx / TotpVerifyView.tsx), so
 * the current user is resolved independently here via the Local API's
 * `payload.auth()`, the documented pattern for "get the current user in a
 * server component" — see
 * https://payloadcms.com/docs/local-api/server-functions.
 *
 * This is UX only (a same-request redirect before the dashboard renders).
 * The actual security boundary is src/access/requireTotpVerified.ts —
 * even a direct API call bypassing this component entirely still can't
 * read/write protected collections without a valid step-up cookie.
 */
export default async function BeforeDashboardTotpGate({ payload }: { payload: Payload }) {
  const headers = await getHeaders()
  const { user } = await payload.auth({ headers })

  if (!user) return null // Payload's own login gate already covers this case

  if (!user.totpEnabled) {
    redirect('/admin/totp-setup')
  }

  if (!isStepUpVerified(headers, String(user.id))) {
    redirect('/admin/totp-verify')
  }

  return null
}
