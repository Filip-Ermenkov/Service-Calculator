import type { MetadataRoute } from 'next'

import { routing } from '@/i18n/routing'
import { getPublishedServiceIds } from '@/lib/content'
import { SITE_URL } from '@/lib/seo'

// Regenerate hourly so newly-published services appear without a redeploy.
export const revalidate = 3600

const STATIC_PATHS = ['', '/projects', '/about', '/careers', '/legal', '/privacy']

/**
 * Localized XML sitemap (TECHSPEC §6.11). One entry per locale-prefixed URL,
 * each carrying `hreflang` alternates for the other locales. Service detail
 * pages are included from the CMS (resilient — an empty/unreachable DB yields
 * just the static pages rather than failing the build).
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const ids = await getPublishedServiceIds()
  const paths = [...STATIC_PATHS, ...ids.map((id) => `/services/${id}`)]
  const now = new Date()

  return paths.flatMap((path) =>
    routing.locales.map((locale) => ({
      url: `${SITE_URL}/${locale}${path}`,
      lastModified: now,
      alternates: {
        languages: Object.fromEntries(
          routing.locales.map((l) => [l, `${SITE_URL}/${l}${path}`]),
        ),
      },
    })),
  )
}
