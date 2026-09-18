import { defineRouting } from 'next-intl/routing'

/**
 * Central i18n routing configuration (TECHSPEC.md §3 "i18n routing", §6.1).
 *
 * URL-prefixed locales (`/en`, `/fr`, `/de`) — the deliberate deviation from
 * FUNCTIONALITY.md §2.1's "session-only" wording, made so each language version
 * is crawlable/indexable and hreflang-taggable (see TECHSPEC §3). EN is the
 * authoring source; FR/DE fall back to EN for CMS content until the Phase 5
 * translation pipeline populates them. UI chrome (nav, buttons, disclaimers) is
 * already fully trilingual via the message catalogs in `src/i18n/messages/`.
 *
 * `localePrefix: 'always'` — every locale carries a prefix (including the
 * default), so there is never an unprefixed, locale-ambiguous public URL. `/`
 * is redirected by the proxy to the best-matching locale (Accept-Language on
 * first visit, then the persisted cookie).
 */
export const routing = defineRouting({
  locales: ['en', 'fr', 'de'],
  defaultLocale: 'en',
  localePrefix: 'always',
  // The one cookie the public site sets (the remembered language — strictly
  // functional, no consent needed, a session cookie by next-intl's default).
  // `Secure` is cookie hygiene rather than a secret to protect: a cookie that
  // is only ever needed over HTTPS should never travel over HTTP (OWASP Session
  // Management cheat sheet). Production served `NEXT_LOCALE=en; Path=/;
  // SameSite=lax` without it until 2026-09-18. Gated on NODE_ENV so a `next dev`
  // server reached over plain http from another device on the LAN (not
  // `localhost`, which browsers treat as secure) still remembers the language.
  localeCookie: {
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  },
})

export type Locale = (typeof routing.locales)[number]
