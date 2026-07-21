/**
 * HTTP security response headers (AWS Well-Architected — Security pillar; OWASP
 * Secure Headers Project).
 *
 * These are applied to **every** route by `next.config.ts`'s `headers()` (see
 * `source: '/:path*'` there), so they cover the public trilingual site, the
 * `/api/quote` route, Payload's `/api/*`, and the `/admin` panel alike. The set
 * is deliberately the subset that is **safe to enforce unconditionally** — none
 * of these can break the Payload admin's inline scripts/styles or the Next.js
 * app's inline styles / `next/font`, because the CSP here restricts only the
 * directives that do NOT govern inline script/style execution.
 *
 * ── Why the CSP is intentionally partial (worth a fresh session knowing) ──────
 * A full XSS-grade CSP needs `script-src`/`style-src` locked down, which for a
 * Next.js + Payload app requires **per-request nonces** threaded through the
 * response (Next's documented nonce-in-`proxy.ts` pattern) — and getting it
 * wrong silently breaks the admin panel at runtime (inline bootstrap script,
 * inline styles) with no build-time error. That is a staging-only-verifiable
 * change, so per this project's "prove risky things on staging / ratchet, don't
 * guess" rule it is a separate, report-only-first follow-up. What ships here is
 * the nonce-FREE, enforce-safe part of a CSP:
 *   - `base-uri 'self'`      → blocks `<base>` tag injection (redirect/hijack).
 *   - `object-src 'none'`    → kills legacy plugin (Flash/embed) vectors.
 *   - `frame-ancestors 'self'` → modern clickjacking defence (superset of the
 *                                legacy `X-Frame-Options`, kept alongside it for
 *                                pre-CSP browsers). `'self'` still allows the
 *                                same-origin admin to frame the site if Live
 *                                Preview is ever enabled.
 *   - `form-action 'self'`   → forms can only POST back to our own origin
 *                              (the quote form → `/api/quote`, admin login, …),
 *                              limiting data-exfiltration on an XSS.
 * Note there is deliberately NO `default-src` here: absent it, script/style/img/
 * font/connect stay unrestricted, so nothing inline breaks. `upgrade-insecure-
 * requests` is also intentionally omitted — it would try to upgrade
 * `http://localhost` sub-resources in local dev / the Playwright `next dev`
 * server; CloudFront already redirects http→HTTPS in front of every deployed
 * stage and HSTS enforces it thereafter, so it adds nothing here.
 */

/** A single Next.js header entry (`{ key, value }`), the shape `headers()` wants. */
export interface SecurityHeader {
  key: string
  value: string
}

/**
 * The enforce-safe Content-Security-Policy (no nonce required). See the module
 * doc-comment for why `script-src`/`style-src`/`default-src` are intentionally
 * absent (a nonce-based, report-only-first follow-up).
 */
export const CONTENT_SECURITY_POLICY = [
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "form-action 'self'",
].join('; ')

/**
 * Locks down powerful browser features the site never uses. An empty allowlist
 * `()` disables the feature for all origins (including this one). Kept to the
 * widely-supported, high-value features; unknown/experimental features are
 * simply ignored by browsers that don't recognise them.
 */
export const PERMISSIONS_POLICY = [
  'accelerometer=()',
  'autoplay=()',
  'camera=()',
  'display-capture=()',
  'encrypted-media=()',
  'fullscreen=(self)',
  'geolocation=()',
  'gyroscope=()',
  'magnetometer=()',
  'microphone=()',
  'payment=()',
  'usb=()',
  'browsing-topics=()',
].join(', ')

/**
 * The canonical security-header set, imported by `next.config.ts` (to serve them)
 * and by `tests/int/securityHeaders.int.spec.ts` (to assert them) — one source of
 * truth so config and test can never drift.
 */
export const securityHeaders: SecurityHeader[] = [
  // Force HTTPS for 2 years (OWASP-recommended max-age), including subdomains.
  // `preload` is deliberately NOT set yet: the app still runs on a shared
  // *.cloudfront.net host (which cannot be HSTS-preloaded) — add `preload` at
  // launch on the real `bulbau.lu` custom domain. Browsers ignore HSTS on plain
  // HTTP and on localhost, so sending it in dev/CI is harmless.
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains',
  },
  // Stop MIME-type sniffing (defends against content-type confusion attacks).
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // Send only the origin cross-site, and nothing on HTTPS→HTTP downgrades.
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // Legacy clickjacking defence for browsers predating CSP `frame-ancestors`
  // (which is the authoritative control, set in the CSP below).
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  // Explicitly disable the deprecated, buggy legacy XSS auditor and rely on CSP
  // instead — current OWASP guidance (`X-XSS-Protection: 0`).
  { key: 'X-XSS-Protection', value: '0' },
  // Block Adobe cross-domain policy files (Flash/PDF-era data exfiltration).
  { key: 'X-Permitted-Cross-Domain-Policies', value: 'none' },
  // Isolate this site's browsing-context group from cross-origin windows.
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Permissions-Policy', value: PERMISSIONS_POLICY },
  { key: 'Content-Security-Policy', value: CONTENT_SECURITY_POLICY },
]
