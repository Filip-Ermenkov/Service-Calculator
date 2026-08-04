import type {
  CollectionAfterChangeHook,
  CollectionAfterDeleteHook,
  GlobalAfterChangeHook,
} from 'payload'

// Statically imported (NOT a dynamic import): this module is server-only — it is
// only ever reached from a Payload afterChange/afterDelete hook, exactly like the
// AWS Translate hook, which statically imports its AWS SDK client and ships fine.
// A dynamic `import('./cdn/invalidate')` risked OpenNext/esbuild not bundling the
// module into the Lambda, so the import would throw `Cannot find module` at
// runtime and the CDN purge would be silently swallowed.
import { invalidateCdn } from './cdn/invalidate'

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
 *
 * INTERACTION WITH AUTO-TRANSLATION (important — see src/lib/translation/hook.ts).
 * A translated collection/global runs the translation `afterChange` hook BEFORE
 * this revalidate hook. That hook makes its own nested FR/DE writes and sets
 * `req.context.disableRevalidate = true` so those nested writes don't each
 * revalidate. In practice that flag is NOT reliably cleared before this top-level
 * revalidate hook runs (Payload's per-operation context restore didn't reach the
 * outer save — observed: every revalidate fire saw `disableRevalidate=true`), so
 * the standalone hook below would be permanently suppressed for translated
 * content. Rather than depend on that restore, the translation hook itself calls
 * `revalidatePublicSiteNow()` exactly once after it finishes. So: the standalone
 * hook stays suppressed by the flag for translated saves (correct — translation
 * already revalidated), and runs normally for non-translated saves and deletes
 * (where the flag is never set).
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

/**
 * Do the revalidation + CDN purge UNCONDITIONALLY (no flag check). Called either
 * by the flag-gated `revalidatePublicSite` wrapper (non-translated saves/deletes)
 * or directly, exactly once, by the auto-translation hook. Never throws.
 */
export async function revalidatePublicSiteNow(source = 'hook'): Promise<void> {
  console.warn(`[revalidate] revalidating public site + purging CDN (${source})`)
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
  // failure must never break the admin save — the ISR window remains the safety
  // net. No-op when unconfigured (local dev / CI / tests).
  try {
    await invalidateCdn()
  } catch (err) {
    console.warn('[revalidate] CDN invalidation skipped:', (err as Error)?.message)
  }
}

async function revalidatePublicSite(context?: {
  disableRevalidate?: unknown
}): Promise<void> {
  // Suppressed for seed/migrate/test (they set the flag) AND for auto-translation
  // saves (the translation hook sets it and revalidates itself once — see the
  // block comment above). Non-translated saves/deletes fall through and revalidate.
  if (context?.disableRevalidate) return
  await revalidatePublicSiteNow('standalone hook')
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
