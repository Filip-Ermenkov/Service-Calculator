import { getPayload, type Payload } from 'payload'

import configPromise from '@/payload.config'
import { logOpsEvent, type OpsContext } from '@/lib/observability/opsLog'
import type { Locale } from '@/i18n/routing'
import type {
  CareerListing,
  CompanyInfo,
  LegalInfo,
  Media,
  Project,
  Service,
} from '@/payload-types'

/**
 * Server-only data access for the public site (TECHSPEC §6.2).
 *
 * Every read goes through Payload's Local API with `overrideAccess: false`, so
 * the SAME access rules that guard the REST boundary (src/access/publicRead.ts)
 * apply here too: anonymous callers see only published/active documents, drafts
 * and archived items stay invisible. This is deliberately DRY — the public site
 * cannot accidentally diverge from the tested access policy.
 *
 * Passing `locale` returns that locale's values; because the Payload config sets
 * `localization.fallback: true`, an untranslated FR/DE field falls back to its
 * EN source, so the site is coherent before the Phase 5 translation pipeline.
 *
 * Every fetcher FAILS LOUDLY. A database or CMS failure logs one `OPS_ALERT`
 * (src/lib/observability/opsLog.ts, which the `app-ops-alerts` alarm watches)
 * and then throws `ContentUnavailableError`. It never returns an empty result
 * in place of an error, because on this site an empty result gets cached:
 *
 *  - At runtime, a page is regenerated in the background (ISR). Next.js keeps
 *    serving the last good version only when that render THROWS: "If an error
 *    is thrown while attempting to revalidate data, the last successfully
 *    generated data will continue to be served from the cache"
 *    (nextjs.org/docs/app/guides/incremental-static-regeneration). Until
 *    2026-11 these functions returned `[]`/`null` instead, so a Neon blip
 *    replaced good pages with empty ones and a service page with a cached 404
 *    (`null` → `notFound()`), at the edge for up to the revalidate window.
 *  - At build time, a throw fails `next build`, so a deploy whose database is
 *    unreachable stops instead of shipping an empty site with a green job.
 *
 * `null`/`[]` therefore mean exactly one thing: the query RAN and found
 * nothing (an unknown or draft slug, no projects yet). Route handlers that must
 * answer even when content is down catch `ContentUnavailableError` themselves
 * (/api/contact, /api/quote).
 */

/** A content read failed; the query did not run to completion. See the header. */
export class ContentUnavailableError extends Error {
  readonly scope: string

  constructor(scope: string, options?: { cause?: unknown }) {
    super(`Content unavailable (${scope})`, options)
    this.name = 'ContentUnavailableError'
    this.scope = scope
  }
}

/** Report a failed read once (OPS_ALERT), then throw. Never returns. */
function contentUnavailable(
  scope: string,
  err: unknown,
  context?: OpsContext,
): never {
  logOpsEvent(scope, err, 'error', context)
  throw new ContentUnavailableError(scope, { cause: err })
}

let clientPromise: Promise<Payload> | null = null

export async function getPayloadClient(): Promise<Payload> {
  if (!clientPromise) {
    const pending = getPayload({ config: configPromise })
    clientPromise = pending
    // Never keep a FAILED init. Payload connects to the database while it
    // initialises, so a cold start during a Neon outage rejects here; keeping
    // that rejected promise would fail every later request on this Lambda
    // instance until it is recycled, long after the database came back.
    pending.catch(() => {
      if (clientPromise === pending) clientPromise = null
    })
  }
  return clientPromise
}

/** Resolve a Payload upload field to renderable props, or null if unset. */
export type MediaLike = number | Media | null | undefined
export function mediaProps(
  m: MediaLike,
): { url: string; alt: string; width?: number; height?: number } | null {
  if (!m || typeof m === 'number' || !m.url) return null
  return {
    url: m.url,
    alt: m.alt ?? '',
    width: m.width ?? undefined,
    height: m.height ?? undefined,
  }
}

export async function getServices(locale: Locale): Promise<Service[]> {
  try {
    const payload = await getPayloadClient()
    const res = await payload.find({
      collection: 'services',
      locale,
      depth: 1,
      limit: 100,
      sort: '_order', // drag order set in admin = Home-page card order (FUNCTIONALITY §3.1)
      overrideAccess: false,
    })
    return res.docs
  } catch (err) {
    contentUnavailable('content.getServices', err, { locale })
  }
}

/**
 * How many service cards the Home page should show, from the drag order
 * (home-settings global; set on the Services admin screen). 0 = show all.
 * 0 before the global's first save. Throws on a failed read (see the header).
 */
export async function getServiceCardLimit(): Promise<number> {
  try {
    const payload = await getPayloadClient()
    const s = (await payload.findGlobal({
      slug: 'home-settings' as never,
      depth: 0,
      overrideAccess: false,
    })) as { serviceCardLimit?: number } | null
    const n = typeof s?.serviceCardLimit === 'number' ? s.serviceCardLimit : 0
    return n > 0 ? n : 0
  } catch (err) {
    contentUnavailable('content.getServiceCardLimit', err)
  }
}

/** Look up one published service by its URL slug (→ null for draft/unknown). */
export async function getServiceBySlug(
  slug: string,
  locale: Locale,
): Promise<Service | null> {
  try {
    const payload = await getPayloadClient()
    const res = await payload.find({
      collection: 'services',
      where: { slug: { equals: slug } },
      locale,
      depth: 2, // populate hero/card media + any uploads inside rich text
      limit: 1,
      overrideAccess: false, // drafts stay invisible — same policy as the REST boundary
    })
    return res.docs[0] ?? null
  } catch (err) {
    contentUnavailable('content.getServiceBySlug', err, { slug, locale })
  }
}

/** Published service slugs for generateStaticParams (throws on a failed read). */
export async function getPublishedServiceSlugs(): Promise<string[]> {
  try {
    const payload = await getPayloadClient()
    const res = await payload.find({
      collection: 'services',
      depth: 0,
      limit: 500,
      pagination: false,
      overrideAccess: false,
      select: { slug: true },
    })
    return res.docs
      .map((d) => d.slug)
      .filter((s): s is string => typeof s === 'string' && s.length > 0)
  } catch (err) {
    contentUnavailable('content.getPublishedServiceSlugs', err)
  }
}

/**
 * Published services for the sitemap: slug + last modification, so `lastmod`
 * reflects a real edit (Google only honours lastmod when it is consistently
 * truthful; stamping "now" on every regeneration is the same as omitting it,
 * except it also looks like a lie). Throws on a failed read.
 */
export async function getPublishedServicesForSitemap(): Promise<
  { slug: string; updatedAt: string }[]
> {
  try {
    const payload = await getPayloadClient()
    const res = await payload.find({
      collection: 'services',
      depth: 0,
      limit: 500,
      pagination: false,
      overrideAccess: false,
      select: { slug: true, updatedAt: true },
    })
    return res.docs.flatMap((d) =>
      typeof d.slug === 'string' && d.slug.length > 0
        ? [{ slug: d.slug, updatedAt: d.updatedAt }]
        : [],
    )
  } catch (err) {
    contentUnavailable('content.getPublishedServicesForSitemap', err)
  }
}

export async function getProjects(locale: Locale): Promise<Project[]> {
  try {
    const payload = await getPayloadClient()
    const res = await payload.find({
      collection: 'projects',
      locale,
      depth: 1, // populate photo + the related service (for the category tag)
      limit: 500,
      pagination: false,
      // The admin's drag order (Projects is `orderable` since 2026-09-14). It
      // starts out as "newest completion first" — the migration backfilled it
      // that way and a new project is inserted at the top — so FUNCTIONALITY
      // §3.2's default holds, and the admin can now curate exceptions by hand.
      sort: '_order',
      overrideAccess: false,
    })
    return res.docs
  } catch (err) {
    contentUnavailable('content.getProjects', err, { locale })
  }
}

export async function getCareers(locale: Locale): Promise<CareerListing[]> {
  try {
    const payload = await getPayloadClient()
    const res = await payload.find({
      collection: 'career-listings',
      locale,
      depth: 1,
      limit: 200,
      pagination: false,
      sort: '_order', // admin drag order = display order (FUNCTIONALITY §5.5)
      overrideAccess: false,
    })
    return res.docs
  } catch (err) {
    contentUnavailable('content.getCareers', err, { locale })
  }
}

export async function getCompanyInfo(locale: Locale): Promise<CompanyInfo | null> {
  try {
    const payload = await getPayloadClient()
    return await payload.findGlobal({
      slug: 'company-info',
      locale,
      depth: 0,
      overrideAccess: false,
    })
  } catch (err) {
    contentUnavailable('content.getCompanyInfo', err, { locale })
  }
}

export async function getLegalInfo(locale: Locale): Promise<LegalInfo | null> {
  try {
    const payload = await getPayloadClient()
    return await payload.findGlobal({
      slug: 'legal-info',
      locale,
      depth: 0,
      overrideAccess: false,
    })
  } catch (err) {
    contentUnavailable('content.getLegalInfo', err, { locale })
  }
}
