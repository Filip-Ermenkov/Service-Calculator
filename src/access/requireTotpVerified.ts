import type { Access } from 'payload'

import { isStepUpVerified } from '@/lib/totp/requestHelpers'

/**
 * Wraps a collection/global `access` function so it also requires a
 * completed TOTP second factor, not just Payload's own password session.
 *
 * This is the actual security boundary for the 2FA feature — the
 * /totp-verify admin view and the beforeDashboard redirect (see
 * src/app/(payload)/admin/...) exist for UX, but access control here is
 * what makes bypassing the UI (e.g. calling the REST/GraphQL API directly)
 * pointless without also passing TOTP.
 *
 * Behaviour:
 * - No `req.user` at all (not logged in) -> denied, same as normal Payload.
 * - `req.user.totpEnabled` is false (2FA not yet enrolled) -> denied. A
 *   brand-new admin account cannot read/write anything protected by this
 *   wrapper until they finish TOTP enrollment — enforced because
 *   FUNCTIONALITY.md §5.1 treats 2FA as mandatory, not optional, and the
 *   /totp/setup + /totp/enable endpoints themselves only require
 *   `req.user` (not this wrapper) so enrollment itself is always reachable.
 * - `totpEnabled` is true but no valid step-up cookie for this request ->
 *   denied (logged in with password, hasn't completed this session's TOTP
 *   check yet).
 * - Otherwise -> delegates to the wrapped `baseAccess` function, so normal
 *   per-collection access logic (e.g. Media's public `read`) still applies
 *   on top of this.
 */
export function requireTotpVerified(baseAccess: Access): Access {
  return async (args) => {
    const { req } = args
    if (!req.user) return false
    if (!req.user.totpEnabled) return false

    const headers = req.headers as Headers
    if (!isStepUpVerified(headers, String(req.user.id))) return false

    return baseAccess(args)
  }
}
