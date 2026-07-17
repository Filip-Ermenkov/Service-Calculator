import { redirect } from 'next/navigation'

import { routing } from '@/i18n/routing'

/**
 * `/` → default locale. The proxy (src/proxy.ts) already redirects `/` to the
 * visitor's best-matching locale (Accept-Language, then cookie) before this
 * renders; this is the no-JS / proxy-bypassed fallback so `/` is never a dead
 * end.
 */
export default function RootPage() {
  redirect(`/${routing.defaultLocale}`)
}
