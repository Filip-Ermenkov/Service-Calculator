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
 * IMPORTANT — revalidate by ROUTE-FILE PATTERN, not by URL. Next tags cache
 * entries by the route FILE that renders them, and (verified against the Next 16
 * `revalidatePath` docs) a `layout` revalidation does NOT reliably cascade into a
 * nested DYNAMIC child route on OpenNext. The site's service page
 * (`/[locale]/services/[slug]`) is exactly such a route, so a plain
 * `revalidatePath('/', 'layout')` left it to refresh only on its 300s timer while
 * the home/list pages updated instantly (the Phase-5 "translations lag on the
 * service page" bug). The fix is to also revalidate that dynamic route explicitly
 * with the `page` type, which invalidates every matching slug/locale at once.
 *
 * Two safeguards make this impossible to turn into a broken admin save:
 *   1. `context.disableRevalidate` — seed scripts, integration tests and the
 *      `payload migrate` CLI drive the Local API OUTSIDE a Next request scope,
 *      where `revalidatePath` legitimately throws. They pass this flag to skip.
 *   2. try/catch — any other non-request invocation is swallowed with a warning
 *      rather than surfaced as a 500 on the mutation.
 */
async function revalidatePublicSite(context?: {
  disableRevalidate?: unknown
}): Promise<void> {
  if (context?.disableRevalidate) return
  try {
    const { revalidatePath } = await import('next/cache')
    // Global purge of all cached route data + the caller's client cache.
    revalidatePath('/', 'layout')
    // The localized layout (route-file pattern) — every locale + its non-dynamic
    // pages (home, projects, about, careers, legal, privacy).
    revalidatePath('/[locale]', 'layout')
    // The nested DYNAMIC service page for ALL slugs/locales — the layout cascade
    // above misses this on OpenNext, so it's revalidated explicitly (`page`).
    revalidatePath('/[locale]/services/[slug]', 'page')
    // Over-revalidating a low-traffic marketing site is cheap; missing a page is
    // not — hence both the global purge and the explicit dynamic-route target.
  } catch (err) {
    console.warn(
      '[revalidate] skipped (not in a request scope?):',
      (err as Error)?.message,
    )
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
