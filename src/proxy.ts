import { createHash } from 'crypto'

import { jwtVerify } from 'jose'
import { NextResponse } from 'next/server'

import type { NextRequest } from 'next/server'

import { isStepUpVerified } from '@/lib/totp/requestHelpers'

/**
 * Closes a gap the TOTP access-control wrapper (src/access/requireTotpVerified.ts)
 * does NOT cover on its own: that wrapper blocks the underlying DATA reads/writes
 * for a collection, but does nothing to stop the admin SPA's own client-side router
 * from navigating to and rendering a route shell like /admin/collections/users for a
 * user who passed the password step but hasn't completed TOTP yet (confirmed via a
 * failing e2e test — a direct `page.goto('/admin/collections/users')` rendered the
 * page instead of redirecting, because nothing at the routing layer knew to stop it).
 *
 * This file is Next.js's server-side request interceptor — named `proxy.ts`, not
 * `middleware.ts`: as of Next.js 16 (which this project is on), `middleware.ts` is
 * deprecated in favor of `proxy.ts`, and Proxy defaults to the Node.js runtime — see
 * https://nextjs.org/docs/app/api-reference/file-conventions/proxy.
 *
 * Deliberately kept as a UX/routing improvement layer, not the sole security
 * boundary — matching this codebase's existing pattern (BeforeDashboardTotpGate,
 * TotpSetupView, TotpVerifyView are all the same: best-effort redirects for a good
 * user experience). The real guarantee is still `requireTotpVerified` on each
 * collection's `access`, which runs against real, DB-loaded `req.user` state no
 * matter how a request reaches the server. Unlike those other views, though, this
 * file DOES cryptographically verify the session token below — see why in the next
 * paragraph — so in practice this file is also a correct, defense-in-depth check on
 * its own, not merely an optimistic guess.
 *
 * Session verification uses `jose`'s `jwtVerify`, the same library — and the same
 * pattern — Next.js's own docs recommend for Proxy-layer auth checks (see
 * https://nextjs.org/docs/app/guides/authentication#optimistic-checks-with-proxy-optional).
 *
 * CRITICAL — the signing key is NOT the raw `PAYLOAD_SECRET`. Payload derives its
 * HS256 key from the configured secret on init and signs with THAT, so verifying
 * against the raw value fails every real token with "signature verification failed".
 * The exact derivation (see node_modules/payload/dist/index.js, `BasePayload` init:
 * `this.secret = crypto.createHash('sha256').update(this.config.secret).digest('hex').slice(0, 32)`)
 * is reproduced in `payloadJwtKey` below and must stay in lockstep with it. jwtSign
 * then does `new TextEncoder().encode(secret)` on that derived string
 * (node_modules/payload/dist/auth/jwt.js). A genuine signature match here therefore
 * confirms a live, unexpired Payload session — not just a well-shaped cookie.
 *
 * The step-up ("has this session completed TOTP?") check reuses
 * src/lib/totp/requestHelpers.ts's `isStepUpVerified`, the exact same HMAC
 * verification already used by requireTotpVerified and every TOTP route handler,
 * rather than a second, separate implementation here.
 */

const PUBLIC_ADMIN_PATH_PREFIXES = [
  '/admin/login',
  '/admin/logout',
  '/admin/forgot',
  '/admin/reset',
  '/admin/create-first-user',
  '/admin/totp-setup',
  '/admin/totp-verify',
]

function isPublicAdminPath(pathname: string): boolean {
  return PUBLIC_ADMIN_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  )
}

/**
 * Reproduces Payload's own JWT key derivation so the proxy verifies against the
 * exact key Payload signed with. Payload does NOT use the raw configured secret:
 * on init it computes `sha256(secret)` as a hex string and truncates to 32 chars,
 * then signs (and verifies) with `TextEncoder().encode(...)` of that. Exported so
 * tests (tests/int/proxy.int.spec.ts) mint tokens the identical way instead of
 * reimplementing this and silently drifting — the exact class of bug this fixes:
 * the original proxy verified against the raw secret, so every real Payload token
 * failed signature verification and the gate never fired.
 */
export function payloadJwtKey(rawSecret: string): Uint8Array {
  const derived = createHash('sha256').update(rawSecret).digest('hex').slice(0, 32)
  return new TextEncoder().encode(derived)
}

/**
 * Verifies the `payload-token` JWT and returns the signed-in user's id as a
 * string, or undefined if the cookie is missing, malformed, expired, or has
 * an invalid signature (all treated identically: "no confirmed session").
 *
 * Normalizes to a string because Payload's `id` claim is numeric for this
 * project (integer/serial primary keys via @payloadcms/db-postgres), but
 * every other part of this codebase compares user ids as strings — e.g.
 * requireTotpVerified's `String(req.user.id)` and every call site of
 * buildStepUpSetCookie/isStepUpVerified in Users.endpoints.ts. Matching that
 * convention here, rather than assuming `id` is already a string, matters:
 * an earlier version of this function required `typeof id === 'string'` and
 * silently rejected every real session as a result, since a real session's
 * `id` claim is a number.
 */
async function verifiedPayloadUserId(token: string): Promise<string | undefined> {
  const secret = process.env.PAYLOAD_SECRET
  if (!secret) return undefined

  try {
    const { payload } = await jwtVerify(token, payloadJwtKey(secret), {
      algorithms: ['HS256'],
    })
    const { id } = payload as { id?: unknown }
    if (typeof id === 'string' || typeof id === 'number') {
      return String(id)
    }
    return undefined
  } catch {
    return undefined
  }
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl

  if (isPublicAdminPath(pathname)) {
    return NextResponse.next()
  }

  const token = request.cookies.get('payload-token')?.value
  const userId = token ? await verifiedPayloadUserId(token) : undefined
  if (!userId) {
    // No session cookie (or an invalid/expired/forged one) — nothing to
    // gate yet, Payload's own admin UI already redirects unauthenticated
    // visitors to /admin/login.
    return NextResponse.next()
  }

  if (isStepUpVerified(request.headers, userId)) {
    return NextResponse.next()
  }

  const redirectUrl = request.nextUrl.clone()
  redirectUrl.pathname = '/admin/totp-verify'
  redirectUrl.search = ''
  return NextResponse.redirect(redirectUrl)
}

export const config = {
  matcher: ['/admin/:path*'],
}
