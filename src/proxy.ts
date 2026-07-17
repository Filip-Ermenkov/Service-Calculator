import { createHash } from 'crypto'

import { jwtVerify } from 'jose'
import createMiddleware from 'next-intl/middleware'
import { NextResponse } from 'next/server'

import type { NextRequest } from 'next/server'

import { routing } from '@/i18n/routing'
import { isStepUpVerified } from '@/lib/totp/requestHelpers'

/**
 * Next.js' server-side request interceptor — named `proxy.ts`, not
 * `middleware.ts`: as of Next.js 16 (which this project is on) `middleware.ts`
 * is deprecated in favour of `proxy.ts`, and Proxy defaults to the Node.js
 * runtime (see https://nextjs.org/docs/app/api-reference/file-conventions/proxy).
 * The Node runtime is required here for `crypto`/`jose` in the admin gate below.
 *
 * This one file now composes TWO responsibilities, dispatched purely by path so
 * they never interfere:
 *
 *   1. `/admin/*` → the TOTP admin gate (unchanged from Phase 1). The admin
 *      panel is intentionally NOT localized, so next-intl never touches it.
 *   2. everything else → next-intl's i18n routing (locale negotiation, the
 *      `/ → /<locale>` redirect, `<locale>`-prefix rewrites, alternate links).
 *
 * next-intl's own docs bless exactly this "composing other middlewares" shape
 * (https://next-intl.dev/docs/routing/middleware#composing-other-middlewares):
 * build the i18n middleware once and call it for the requests it should own.
 *
 * ── Admin gate rationale (retained verbatim from Phase 1) ─────────────────────
 * Closes a gap the TOTP access-control wrapper (src/access/requireTotpVerified.ts)
 * does NOT cover on its own: that wrapper blocks the underlying DATA reads/writes
 * for a collection, but does nothing to stop the admin SPA's own client-side
 * router from navigating to and rendering a route shell like
 * /admin/collections/users for a user who passed the password step but hasn't
 * completed TOTP yet. Kept as a UX/routing improvement layer, not the sole
 * security boundary — the real guarantee is still `requireTotpVerified` on each
 * collection's `access`. Unlike the other TOTP views, this file DOES
 * cryptographically verify the session token (see `payloadJwtKey`), so it is also
 * a correct defence-in-depth check, not merely an optimistic guess.
 *
 * CRITICAL — the signing key is NOT the raw `PAYLOAD_SECRET`. Payload derives its
 * HS256 key from the configured secret on init and signs with THAT, so verifying
 * against the raw value fails every real token with "signature verification
 * failed". The exact derivation (node_modules/payload/dist/index.js, `BasePayload`
 * init: `crypto.createHash('sha256').update(secret).digest('hex').slice(0, 32)`)
 * is reproduced in `payloadJwtKey` and must stay in lockstep with it.
 */

const handleI18nRouting = createMiddleware(routing)

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
 * string, or undefined if the cookie is missing, malformed, expired, or has an
 * invalid signature (all treated identically: "no confirmed session").
 *
 * Normalizes to a string because Payload's `id` claim is numeric for this
 * project (integer/serial primary keys via @payloadcms/db-postgres), but every
 * other part of this codebase compares user ids as strings.
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

/**
 * The Phase 1 admin gate, unchanged in behaviour. Runs only for `/admin/*`.
 */
async function adminGate(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl

  if (isPublicAdminPath(pathname)) {
    return NextResponse.next()
  }

  const token = request.cookies.get('payload-token')?.value
  const userId = token ? await verifiedPayloadUserId(token) : undefined
  if (!userId) {
    // No session cookie (or an invalid/expired/forged one) — nothing to gate
    // yet; Payload's own admin UI already redirects unauthenticated visitors to
    // /admin/login.
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

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl

  // The admin panel is unlocalized: gate it and return before next-intl can see
  // it. `/api/*` is excluded by the matcher, so it reaches neither branch.
  if (pathname === '/admin' || pathname.startsWith('/admin/')) {
    return adminGate(request)
  }

  // Everything else is a public, localized route — hand it to next-intl.
  return handleI18nRouting(request)
}

export const config = {
  // Run on every request EXCEPT Payload's API (`/api`), Next internals
  // (`/_next`, `/_vercel`) and static files (any path containing a dot). This
  // single matcher covers both branches above: `/admin/*` still matches (so the
  // admin gate runs) while all public pages match for i18n routing. Mirrors
  // next-intl's recommended matcher.
  matcher: ['/((?!api|_next|_vercel|.*\\..*).*)'],
}
