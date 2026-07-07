import type { Access, Where } from 'payload'

import { isStepUpVerified } from '@/lib/totp/requestHelpers'

/**
 * Is this request from a *fully* authenticated admin — password session AND a
 * completed TOTP second factor?
 *
 * This mirrors the exact three checks in `requireTotpVerified` (the write-side
 * security boundary): a logged-in user, `totpEnabled`, and a valid step-up
 * cookie for that user id. It is deliberately kept in lockstep with that file;
 * a password-only session (no TOTP yet) is intentionally NOT treated as an
 * admin here, so it can never see unpublished/draft content through the public
 * read path either.
 */
export function isFullyVerified(req: { user?: unknown; headers: unknown }): boolean {
  const user = req.user as { id?: unknown; totpEnabled?: boolean } | undefined
  if (!user) return false
  if (!user.totpEnabled) return false
  return isStepUpVerified(req.headers as Headers, String(user.id))
}

/**
 * Read access for public, content-bearing collections/globals.
 *
 * - A fully 2FA-verified admin can read everything, including drafts/archived
 *   documents (needed for the admin List views and to restore archived items).
 * - Everyone else — anonymous public visitors AND password-only (non-TOTP)
 *   sessions — is limited to the documents matching `publicWhere`, i.e. the
 *   published/active ones only.
 *
 * Returning a Where query constraint (rather than a bare `false`) is what lets
 * the public site read published content while drafts stay invisible. This is
 * the pattern Payload documents for draft visibility:
 * https://payloadcms.com/docs/versions/drafts#restricting-draft-access
 */
export function publicReadWhen(publicWhere: Where): Access {
  return ({ req }) => {
    if (isFullyVerified(req)) return true
    return publicWhere
  }
}

/** Published-only constraint for draft-enabled collections (`_status`). */
export const readPublishedOrVerified: Access = publicReadWhen({
  _status: { equals: 'published' },
})
