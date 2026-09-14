import { createHmac, timingSafeEqual } from 'crypto'

import { getSigningKey } from './keys'

/**
 * The "second factor verified" step-up token.
 *
 * Payload's own auth cookie proves "this request has a valid
 * email+password session" (first factor). It does not, and structurally
 * cannot without forking Payload, also prove "and this session completed
 * TOTP verification" — so a second, independent signed token carries that
 * fact. It's set as its own httpOnly cookie (see route handlers) after a
 * successful call to /api/users/totp/verify, separate from Payload's JWT.
 *
 * Access control (src/access/requireTotpVerified.ts) then requires BOTH:
 * Payload's own `req.user` (first factor) AND a valid, non-expired,
 * matching-user step-up token (second factor) before granting access to
 * anything beyond the enrollment/verification endpoints themselves. This
 * mirrors the "access wrapper" pattern used by existing Payload TOTP
 * plugins (evaluated and not depended on directly — see docs/PROGRESS.md
 * — but the pattern itself is sound and worth reusing).
 *
 * Deliberately a plain HMAC construction rather than a full JWT library:
 * the payload is two fields (user id, expiry), there's no need for
 * algorithm negotiation or third-party verification, and one fewer
 * dependency is one fewer thing that can drift out of date.
 */

const TOKEN_TTL_SECONDS = 2 * 60 * 60 // matches Payload's default tokenExpiration (2h)

interface StepUpPayload {
  uid: string
  exp: number // unix seconds
}

function base64url(input: Buffer): string {
  return input.toString('base64url')
}

export function signStepUpToken(userId: string): string {
  const payload: StepUpPayload = {
    uid: userId,
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
  }
  const payloadB64 = base64url(Buffer.from(JSON.stringify(payload), 'utf8'))
  const signature = createHmac('sha256', getSigningKey()).update(payloadB64).digest('base64url')
  return `${payloadB64}.${signature}`
}

/**
 * Verifies a step-up token belongs to `expectedUserId` and hasn't expired.
 * Returns false for any malformed, forged, expired, or mismatched-user
 * token — callers don't need to distinguish why it failed.
 */
export function verifyStepUpToken(token: string | undefined, expectedUserId: string): boolean {
  if (!token) return false

  const parts = token.split('.')
  if (parts.length !== 2) return false
  const [payloadB64, signature] = parts

  const expectedSignature = createHmac('sha256', getSigningKey())
    .update(payloadB64)
    .digest('base64url')

  const sigBuf = Buffer.from(signature)
  const expectedSigBuf = Buffer.from(expectedSignature)
  if (sigBuf.length !== expectedSigBuf.length || !timingSafeEqual(sigBuf, expectedSigBuf)) {
    return false
  }

  let payload: StepUpPayload
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))
  } catch {
    return false
  }

  if (payload.uid !== expectedUserId) return false
  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return false

  return true
}

export const STEP_UP_COOKIE_NAME = 'bulbau-totp-verified'
export const STEP_UP_COOKIE_MAX_AGE_SECONDS = TOKEN_TTL_SECONDS

/**
 * Lifecycle note. This cookie is issued by /api/users/totp/verify and /enable,
 * and EXPIRED by two paths: /api/users/totp/disable (below, explicitly) and
 * Payload's own logout — via the `afterLogout` hook on the Users collection
 * (src/collections/Users.ts, `clearStepUpCookieAfterLogout`), which appends the
 * expired cookie to `req.responseHeaders` so it rides the same response that
 * expires `payload-token`.
 *
 * History, so nobody re-opens it: until 2026-09-13 logout did NOT clear this
 * cookie (recorded as an accepted trade-off — "Payload's logout view has no
 * extension point"). That was wrong: Payload's REST logout runs `afterLogout`
 * hooks and merges `req.responseHeaders` into the response. Consequence of the
 * old gap: log out, log back in with only the password on the SAME browser
 * within the ~2h TTL → the still-valid step-up cookie skipped the TOTP prompt
 * once. Closed by the hook; pinned by tests/int/rest.int.spec.ts.
 */
