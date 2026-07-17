import { getPayload, type Payload } from 'payload'

import configPromise from '@/payload.config'
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
 * Every fetcher is resilient: a DB/CMS failure logs and returns an empty/`null`
 * result instead of throwing, so a transient content-layer problem degrades to
 * an empty section rather than crashing the whole page (and so a build with no
 * database reachable still succeeds, rendering empty states).
 */

let clientPromise: Promise<Payload> | null = null

export async function getPayloadClient(): Promise<Payload> {
  if (!clientPromise) {
    clientPromise = getPayload({ config: configPromise })
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
    console.error('[content] getServices failed:', err)
    return []
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
    console.error(`[content] getServiceBySlug(${slug}) failed:`, err)
    return null
  }
}

/** Published service slugs for generateStaticParams/sitemap (resilient → []). */
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
    console.error('[content] getPublishedServiceSlugs failed:', err)
    return []
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
      sort: '-completionDate', // newest first (FUNCTIONALITY §3.2)
      overrideAccess: false,
    })
    return res.docs
  } catch (err) {
    console.error('[content] getProjects failed:', err)
    return []
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
    console.error('[content] getCareers failed:', err)
    return []
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
    console.error('[content] getCompanyInfo failed:', err)
    return null
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
    console.error('[content] getLegalInfo failed:', err)
    return null
  }
}
