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
  // Dart Sass prepends `@charset "UTF-8";` to any stylesheet whose output
  // contains a non-ASCII byte — which src/app/(payload)/custom.scss does, in its
  // comments alone (em dashes, arrows, "×"). Next's CSS pipeline then rewrites
  // that @charset into a byte-order mark, and Turbopack's parser refuses the
  // file because the BOM leaves the sheet's leading `@import` (the admin's
  // webfont) no longer first — `@import` is only valid before any other rule.
  //
  // The declaration is redundant anyway: every stylesheet here is served as
  // UTF-8 over HTTP, which already wins over an in-file @charset. Turning it off
  // fixes the build at the source instead of banning non-ASCII from comments,
  // which nothing would enforce and the next em dash would silently break.
  sassOptions: {
    charset: false,
  },
  // Client-side Router Cache tuning. The `static` default is 5 MINUTES:
  // prefetched, statically-generated pages are reused from the browser's Client
  // Cache for that long, which made a soft navigation back to an edited page (or
  // the prefetching cross-locale language switcher) serve the stale, pre-edit
  // translation for up to 5 minutes. We drive the reuse windows to their most
  // aggressive allowed values so a freshly-published change shows on the next
  // navigation. NOTE: Next enforces a hard MINIMUM of 30s for `static` (a build
  // error rejects 0), so 30 is the floor — a soft navigation can still show a
  // ≤30s-old copy, but a hard refresh is always instant and a real visitor (who
  // isn't editing) never notices. `dynamic` may be 0.
  experimental: {
    staleTimes: {
      dynamic: 0,
      static: 30,
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
