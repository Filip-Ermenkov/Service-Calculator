import type { Metadata } from 'next'

import { routing, type Locale } from '@/i18n/routing'

/**
 * Canonical origin for absolute URLs (canonical tags, hreflang, OG, sitemap).
 * Overridable per stage via NEXT_PUBLIC_SITE_URL — on staging this is the
 * CloudFront domain, in production the custom domain. Falls back to the prod
 * domain so a missing env var never yields a broken relative canonical.
 */
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL || 'https://bulbau.lu'
).replace(/\/$/, '')

/**
 * Search-engine indexing is OFF by default and only enabled by an explicit
 * `NEXT_PUBLIC_ALLOW_INDEXING=true` (set only on the production stage). This is
 * deliberately an opt-in flag rather than a hostname check: staging is served
 * from a dynamic CloudFront URL with no custom domain, so anything host-based
 * risks accidentally indexing it. Safe default = noindex everywhere until launch
 * flips this on (a Phase 7 step).
 */
export const IS_INDEXABLE = process.env.NEXT_PUBLIC_ALLOW_INDEXING === 'true'

/**
 * hreflang + canonical for a page. `path` is the locale-independent pathname
 * (e.g. '' for home, '/projects', '/services/12'); this expands it to a
 * canonical for the current locale plus `<link rel="alternate" hreflang>` for
 * every locale and an `x-default` (TECHSPEC §6.11).
 *
 * `x-default` is the UNPREFIXED path (`/`, `/projects`): that URL is the one
 * next-intl's proxy language-negotiates (Accept-Language → 307 to `/en|/fr|/de`),
 * which is exactly what Google defines x-default as — the page for visitors no
 * listed language matches. It also makes the HTML tags agree with the `Link:`
 * header next-intl adds to every response (which already said `x-default` = the
 * unprefixed URL); until 2026-09-18 the two contradicted each other (`/en` in
 * the HTML, `/` in the header), leaving crawlers to pick one.
 */
export function buildAlternates(
  locale: Locale,
  path: string,
): NonNullable<Metadata['alternates']> {
  const clean = path === '/' ? '' : path
  const languages: Record<string, string> = {}
  for (const l of routing.locales) languages[l] = `/${l}${clean}`
  languages['x-default'] = clean || '/'
  return { canonical: `/${locale}${clean}`, languages }
}

/** Shared page-metadata builder: title, description, canonical/hreflang, OG. */
export function pageMetadata(opts: {
  locale: Locale
  path: string
  title?: string
  description?: string
  images?: string[]
}): Metadata {
  const alternates = buildAlternates(opts.locale, opts.path)
  // Only emit a `title` when the page actually has one. Returning
  // `title: undefined` here does NOT inherit the layout's `title.default` — it
  // OVERRIDES it, leaving the page with no <title> (a WCAG 2.4.2 failure caught
  // by the axe gate on the home page, which passes no title). Omitting the key
  // lets the layout default ("%s — Bulbau" template / defaultTitle) apply, while
  // pages that do pass a title still get it (with the template suffix).
  return {
    ...(opts.title ? { title: opts.title } : {}),
    description: opts.description,
    alternates,
    openGraph: {
      ...(opts.title ? { title: opts.title } : {}),
      description: opts.description,
      url: alternates.canonical as string,
      siteName: 'Bulbau',
      locale: opts.locale,
      type: 'website',
      ...(opts.images && opts.images.length ? { images: opts.images } : {}),
    },
  }
}
