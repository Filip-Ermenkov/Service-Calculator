import type { MetadataRoute } from 'next'

import { IS_INDEXABLE, SITE_URL } from '@/lib/seo'

/**
 * robots.txt (TECHSPEC §6.11). Only the production stage (IS_INDEXABLE) invites
 * crawlers; every other stage disallows everything so the CloudFront staging URL
 * can never be indexed. The admin panel and API are always disallowed.
 */
export default function robots(): MetadataRoute.Robots {
  if (!IS_INDEXABLE) {
    return { rules: [{ userAgent: '*', disallow: '/' }] }
  }
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: ['/admin', '/api'] }],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  }
}
