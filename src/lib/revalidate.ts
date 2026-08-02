import type {
  CollectionAfterChangeHook,
  CollectionAfterDeleteHook,
  GlobalAfterChangeHook,
} from 'payload'

/**
 * On-demand ISR invalidation for the public site (TECHSPEC §6.2).
 *
 * When the admin publishes/edits/deletes content, the affected public pages are
 * revalidated so the change appears without waiting for the time-based ISR
 * window (each public page also sets `export const revalidate`, which is the
 * always-correct safety net if on-demand invalidation ever misses a path).
 *
 * IMPORTANT — revalidate every content page EXPLICITLY by its route-file
 * pattern, not via a layout cascade. Next tags cache entries by the route FILE
 * that renders them, and a `layout` revalidation does NOT reliably cascade into
 * nested DYNAMIC pages on OpenNext. EVERY public page here is a dynamic route
 * (they all sit under the `[locale]` segment), so relying on the cascade left the
 * home cards and list pages refreshing only on their 300s timer while a directly
 * targeted page updated instantly — the Phase-5 "some fields lag" bug. The fix is
 * to revalidate each page pattern with the `page` type (invalidates every locale/
 * slug at once), plus a layout revalidation so a CompanyInfo change reaches the
 * shared header/footer.
 *
 * Two safeguards make this impossible to turn into a broken admin save:
 *   1. `context.disableRevalidate` — seed scripts, integration tests and the
 *      `payload migrate` CLI drive the Local API OUTSIDE a Next request scope,
 *      where `revalidatePath` legitimately throws. They pass this flag to skip.
 *   2. try/catch — any other non-request invocation is swallowed with a warning
 *      rather than surfaced as a 500 on the mutation.
 *
 * `revalidatePath` alone refreshes the S3 origin cache but does NOT purge
 * CloudFront (OpenNext's automatic CDN invalidation is a dummy no-op by default),
 * so after refreshing the origin we also invalidate the CloudFront distribution
 * on-demand (src/lib/cdn/invalidate.ts) — the proper fix that makes an edit
 * appear at the edge within seconds regardless of the ISR window. That call is a
 * no-op when unconfigured (local dev / CI / tests) and never throws.
 */

// Every public content page, by route-file pattern (all are dynamic via [locale]).
const CONTENT_PAGE_PATTERNS = [
  '/[locale]', // home (service cards live here)
  '/[locale]/about',
  '/[locale]/careers',
  '/[locale]/legal',
  '/[locale]/privacy',
  '/[locale]/projects',
  '/[locale]/services/[slug]',
] as const

async function revalidatePublicSite(context?: {
  disableRevalidate?: unknown
}): Promise<void> {
  if (context?.disableRevalidate) return
  try {
    const { revalidatePath } = await import('next/cache')
    // Global purge (also clears the calling request's client cache) + the shared
    // localized layout, so header/footer (CompanyInfo) changes propagate.
    revalidatePath('/', 'layout')
    revalidatePath('/[locale]', 'layout')
    // Each content page explicitly, for ALL locales/slugs — the reliable path on
    // OpenNext. Over-revalidating a low-traffic marketing site is cheap; missing
    // a page is not.
    for (const pattern of CONTENT_PAGE_PATTERNS) {
      revalidatePath(pattern, 'page')
    }
    // The sitemap lists services/pages, so refresh it on any content change too.
    revalidatePath('/sitemap.xml')
  } catch (err) {
    console.warn(
      '[revalidate] skipped (not in a request scope?):',
      (err as Error)?.message,
    )
  }

  // Purge CloudFront so the refreshed origin is actually served at the edge.
  // Separate try/catch (and the module itself never throws): a CDN-invalidation
  // failure must never break the admin save — the ISR window remains the
  // safety net. No-op when unconfigured (local dev / CI / tests). Dynamic import
  // keeps the AWS SDK out of any non-Node bundle, matching `next/cache` above.
  try {
    const { invalidateCdn } = await import('./cdn/invalidate')
    await invalidateCdn()
  } catch (err) {
    console.warn('[revalidate] CDN invalidation skipped:', (err as Error)?.message)
  }
}

export const revalidateContentAfterChange: CollectionAfterChangeHook = async ({
  context,
}) => {
  await revalidatePublicSite(context)
}

export const revalidateContentAfterDelete: CollectionAfterDeleteHook = async ({
  context,
}) => {
  await revalidatePublicSite(context)
}

export const revalidateGlobalAfterChange: GlobalAfterChangeHook = async ({
  context,
}) => {
  await revalidatePublicSite(context)
}
