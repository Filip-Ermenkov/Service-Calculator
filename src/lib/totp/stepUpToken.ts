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
 * Known, accepted trade-off worth a fresh session/reviewer knowing about:
 * Payload's own /admin/logout view clears its own session cookie but has no
 * extension point this feature hooks into to also clear THIS cookie (it's a
 * Link to a built-in Route, not a call this code intercepts). So: log out,
 * then log back in with just the password, on the SAME browser, within the
 * ~2h step-up TTL -> the stale-but-still-valid step-up cookie is still
 * accepted, skipping the TOTP prompt for that one re-login.
 *
 * This does not weaken the feature's actual guarantee (a different device/
 * browser/session always requires the full password+TOTP flow — that's the
 * threat model this exists for), but it is a real, narrower gap: anyone who
 * both knows the password AND has access to the same already-logged-out
 * browser within that window skips the second factor once. Closing it
 * requires either overriding Payload's built-in Logout view/route (real
 * risk of subtly breaking its default behavior for a single-admin site
 * where the practical exposure is already narrow) or shortening the step-up
 * TTL well below Payload's own session length (blunt, and just narrows the
 * window rather than closing it). Deferred rather than done half-confidently
 * — revisit if this ever stops being a single-admin site.
 */
