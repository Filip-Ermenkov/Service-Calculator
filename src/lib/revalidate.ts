import type {
  CollectionAfterChangeHook,
  CollectionAfterDeleteHook,
  GlobalAfterChangeHook,
} from 'payload'

import { routing } from '@/i18n/routing'

/**
 * On-demand ISR invalidation for the public site (TECHSPEC §6.2).
 *
 * When the admin publishes/edits/deletes content, the affected public pages are
 * revalidated so the change appears without waiting for the time-based ISR
 * window (each public page also sets `export const revalidate`, which is the
 * always-correct safety net if on-demand invalidation ever misses a path).
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
    // Sledgehammer + targeted: the root layout, then each locale subtree. Over-
    // revalidating a low-traffic marketing site is cheap; missing a page is not.
    revalidatePath('/', 'layout')
    for (const locale of routing.locales) {
      revalidatePath(`/${locale}`, 'layout')
    }
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
