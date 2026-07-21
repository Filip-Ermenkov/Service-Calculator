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
