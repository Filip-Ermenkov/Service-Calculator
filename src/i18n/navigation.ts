import { createNavigation } from 'next-intl/navigation'

import { routing } from './routing'

/**
 * Locale-aware wrappers around Next.js' navigation APIs. `Link`, `redirect`,
 * `usePathname`, `useRouter` and `getPathname` here automatically keep the
 * active locale prefix in the URL, so components never hand-build `/${locale}/…`
 * paths (the language switcher and every internal link rely on this).
 */
export const { Link, redirect, usePathname, useRouter, getPathname } =
  createNavigation(routing)
