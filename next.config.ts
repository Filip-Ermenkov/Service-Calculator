import { withPayload } from '@payloadcms/next/withPayload'
import createNextIntlPlugin from 'next-intl/plugin'
import type { NextConfig } from 'next'
import path from 'path'
import { fileURLToPath } from 'url'

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
}

// Compose both framework plugins: Payload wires the CMS/admin, next-intl wires
// the i18n request pipeline. Order is not significant here — each augments a
// distinct part of the Next config — but next-intl wraps the outside so its
// plugin sees the fully-assembled Payload config.
export default withNextIntl(withPayload(nextConfig, { devBundleServerPackages: false }))
