import type { MetadataRoute } from 'next'

import { routing } from '@/i18n/routing'
import { getPublishedServicesForSitemap } from '@/lib/content'
import { SITE_URL } from '@/lib/seo'

// Regenerate hourly so newly-published services appear without a redeploy.
export const revalidate = 3600

const STATIC_PATHS = ['', '/projects', '/about', '/careers', '/contact', '/legal', '/privacy']

/**
 * Localized XML sitemap (TECHSPEC §6.11). One entry per locale-prefixed URL,
 * each carrying `hreflang` alternates for the other locales. Service detail
 * pages are included from the CMS. An unreachable database THROWS (see
 * src/lib/content.ts): at runtime the last good sitemap keeps being served, and
 * at build time the build fails rather than publishing a sitemap with no services.
 *
 * `lastModified` is set ONLY where a real modification time exists (a service's
 * `updatedAt`). The static pages carry none: Google ignores lastmod that is not
 * consistently accurate, and stamping every URL with "now" on each regeneration
 * — as this file did until 2026-09-18 — is exactly that.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const services = await getPublishedServicesForSitemap()
  const entries: { path: string; lastModified?: Date }[] = [
    ...STATIC_PATHS.map((path) => ({ path })),
    ...services.map((s) => ({
      path: `/services/${s.slug}`,
      lastModified: new Date(s.updatedAt),
    })),
  ]

  return entries.flatMap(({ path, lastModified }) =>
    routing.locales.map((locale) => ({
      url: `${SITE_URL}/${locale}${path}`,
      ...(lastModified && !Number.isNaN(lastModified.getTime()) ? { lastModified } : {}),
      alternates: {
        languages: Object.fromEntries(
          routing.locales.map((l) => [l, `${SITE_URL}/${l}${path}`]),
        ),
      },
    })),
  )
}
