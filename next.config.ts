import { withPayload } from '@payloadcms/next/withPayload'
import createNextIntlPlugin from 'next-intl/plugin'
import type { NextConfig } from 'next'
import path from 'path'
import { fileURLToPath } from 'url'

// Single source of truth for the OWASP-aligned security response headers, shared
// with tests/int/securityHeaders.int.spec.ts. Relative import (not the `@/`
// alias) so Next's config loader resolves it without the tsconfig path mapping.
import { securityHeaders } from './src/lib/security/headers'

const __filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(__filename)

// Points the next-intl plugin at our request configuration (src/i18n/request.ts),
// which resolves the active locale and loads its UI message catalog per request.
const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts')

const nextConfig: NextConfig = {
  // Client-side Router Cache tuning (verified against the Next 16 `staleTimes`
  // docs). The `static` default is 5 MINUTES: prefetched, statically-generated
  // pages are reused from the browser's Client Cache for that long. On this
  // CMS-driven site that made the language switcher (prefetching cross-locale
  // <Link>s) serve a stale, pre-edit translation for up to 5 minutes before the
  // fresh one appeared ("switch shows old, click again shows new"). Setting the
  // reuse windows to 0 makes every client navigation refetch the page segment
  // from the server, so a freshly-published translation shows immediately — the
  // correct trade-off for a content site (the pages are cheap ISR renders, and
  // shared layouts still aren't refetched per Next's partial-rendering rules).
  experimental: {
    staleTimes: {
      dynamic: 0,
      static: 0,
    },
  },
  images: {
    localPatterns: [
      {
        pathname: '/api/media/file/**',
      },
    ],
  },
  webpack: (webpackConfig) => {
    webpackConfig.resolve.extensionAlias = {
      '.cjs': ['.cts', '.cjs'],
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
      '.mjs': ['.mts', '.mjs'],
    }

    return webpackConfig
  },
  turbopack: {
    root: path.resolve(dirname),
  },
  // Apply the security headers to every route (public site, /api/*, /admin).
  // These are static (no per-request nonce), so next.config `headers()` is the
  // correct, cache-friendly, OpenNext-supported home for them — verified emitted
  // by the running Next server (see the e2e header test), not just present here.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
    ]
  },
}

// Compose both framework plugins: Payload wires the CMS/admin, next-intl wires
// the i18n request pipeline. Order is not significant here — each augments a
// distinct part of the Next config — but next-intl wraps the outside so its
// plugin sees the fully-assembled Payload config.
export default withNextIntl(withPayload(nextConfig, { devBundleServerPackages: false }))
