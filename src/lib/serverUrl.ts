/**
 * Payload `serverURL` for THIS process — the one absolute origin Payload may use
 * to build links in emails (the admin password-reset link) and, via its CSRF
 * allowlist, the one `Origin` it accepts cookie-authenticated requests from.
 *
 * ── Why this exists (found 2026-09-16) ────────────────────────────────────────
 * `payload.config.ts` set neither `serverURL` nor `csrf`. Verified against the
 * installed payload@3.89 source, that meant two things at once:
 *
 *   1. `auth/extractJWT.js`: with `csrf.length === 0` a `payload-token` cookie is
 *      accepted from ANY `Origin` — Payload's own CSRF allowlist was effectively
 *      switched off (SameSite=Lax on the cookie was the only remaining defence).
 *   2. `utilities/getRequestOrigin.js`: with no `serverURL` and no allowlist,
 *      Payload refuses to trust the request's Host header and returns '' — so
 *      the password-reset link in the forgot-password email would have been a
 *      RELATIVE `/admin/reset/<token>`, i.e. unusable in an email. (Refusing the
 *      Host header is correct: building reset links from it is the classic
 *      host-header-injection attack — OWASP Forgot Password Cheat Sheet.)
 *
 * Setting `serverURL` fixes both: Payload's sanitizer pushes it onto `csrf`, so
 * cookie auth is accepted from exactly this origin, and reset links become
 * absolute HTTPS links to a FIXED, configured host — never derived from the
 * request.
 *
 * ── Resolution order (pure; unit-tested in tests/int/emailAdapter.int.spec.ts) ─
 *   1. `NEXT_PUBLIC_SITE_URL` — the stage's canonical origin (the SST `SiteUrl`
 *      secret; the same value src/lib/seo.ts and the OTP labels already use).
 *      Normalised to a bare origin (scheme + host[:port], no path/trailing slash).
 *   2. Otherwise, on the SST **production** stage: the production domain. The
 *      apex is canonical (www redirects to it), so this is exact.
 *   3. Otherwise, outside production mode (`next dev`, vitest, `payload run`):
 *      `http://localhost:3000` — where the dev server, Playwright and the int
 *      tests all live. Without it every local admin login would be refused.
 *   4. Otherwise `''` — Payload's current, permissive behaviour (relative reset
 *      links, open allowlist). This is where a deployed stage WITHOUT `SiteUrl`
 *      lands (staging today); payload.config.ts logs a loud warning for it. It is
 *      deliberately not `https://bulbau.lu`: that would make the staging admin
 *      reject its own origin and lock the admin out.
 *
 * A CI `next build`/`next start` (NODE_ENV=production, no SST stage) falls to 4,
 * never to 2 — see `readSstStage()`.
 */

import { readSstStage } from './observability/stage'

export const PRODUCTION_ORIGIN = 'https://bulbau.lu'
export const LOCAL_DEV_ORIGIN = 'http://localhost:3000'

export interface ServerUrlEnv {
  NEXT_PUBLIC_SITE_URL?: string
  NODE_ENV?: string
  SST_RESOURCE_App?: string
  SST_STAGE?: string
}

/** `https://Host/path/` → `https://host`; null when not an http(s) URL. */
export function normalizeOrigin(value: string | undefined): string | null {
  const raw = value?.trim()
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.origin
  } catch {
    return null
  }
}

export function resolveServerUrl(env: ServerUrlEnv = process.env): string {
  const configured = normalizeOrigin(env.NEXT_PUBLIC_SITE_URL)
  if (configured) return configured
  if (readSstStage(env) === 'production') return PRODUCTION_ORIGIN
  if (env.NODE_ENV !== 'production') return LOCAL_DEV_ORIGIN
  return ''
}

/**
 * True when this is a deployed SST stage that has NO usable origin — the one
 * configuration in which reset links come out relative and the CSRF allowlist
 * stays open. Surfaced as a warning at config load so it cannot go unnoticed.
 */
export function isDeployedWithoutServerUrl(env: ServerUrlEnv = process.env): boolean {
  return readSstStage(env) !== null && resolveServerUrl(env) === ''
}
