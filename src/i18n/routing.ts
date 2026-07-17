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
})

export type Locale = (typeof routing.locales)[number]
