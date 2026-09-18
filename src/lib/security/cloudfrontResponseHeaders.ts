/**
 * The site's security headers, in the shape of a CloudFront **response headers
 * policy** — for responses that never pass through the Next server.
 *
 * Since the media-CDN change (src/lib/media/publicUrl.ts) `/media/*` is answered
 * by CloudFront straight from the S3 bucket. `next.config.ts`'s `headers()` and
 * `src/proxy.ts` never see those responses, so without this they would go out
 * bare: no HSTS on an image response (HSTS is per-host — every response is an
 * opportunity to set or refresh it), no `nosniff` (the one header that matters
 * on a file served from storage), and no browser `Cache-Control`.
 *
 * CloudFront splits the header set in two: six well-known security headers are
 * STRUCTURED fields (`securityHeadersConfig`) and reject being set as plain
 * custom headers; everything else goes in `customHeadersConfig`. This function
 * performs that split from the single `securityHeaders` source of truth in
 * ./headers.ts, so the policy CloudFront serves for `/media/*` and the one Next
 * serves for every other path can never drift apart. `sst.config.ts` imports it
 * dynamically (SST's documented way to share code with the config) and hands
 * the result to `aws.cloudfront.ResponseHeadersPolicy`.
 *
 * Pure: no Pulumi/AWS import — the returned object is plain JSON that is
 * structurally identical to the provider's `ResponseHeadersPolicyArgs` fields,
 * which is what lets tests/int/securityHeaders.int.spec.ts assert it without an
 * AWS SDK.
 */

import {
  CONTENT_SECURITY_POLICY,
  FRAME_OPTIONS,
  HSTS_INCLUDE_SUBDOMAINS,
  HSTS_MAX_AGE_SECONDS,
  HSTS_PRELOAD,
  REFERRER_POLICY,
  securityHeaders,
  type SecurityHeader,
} from './headers'

/** The header names CloudFront insists on receiving as structured fields. */
const STRUCTURED = new Set([
  'strict-transport-security',
  'x-content-type-options',
  'x-frame-options',
  'referrer-policy',
  'x-xss-protection',
  'content-security-policy',
])

export interface CloudFrontSecurityHeadersConfig {
  strictTransportSecurity: {
    accessControlMaxAgeSec: number
    includeSubdomains: boolean
    preload: boolean
    override: true
  }
  contentTypeOptions: { override: true }
  frameOptions: { frameOption: string; override: true }
  referrerPolicy: { referrerPolicy: string; override: true }
  /** `protection: false` is the wire form of our `X-XSS-Protection: 0`. */
  xssProtection: { protection: boolean; override: true }
  contentSecurityPolicy: { contentSecurityPolicy: string; override: true }
}

export interface CloudFrontCustomHeader {
  header: string
  value: string
  override: true
}

export interface CloudFrontResponseHeadersConfig {
  securityHeadersConfig: CloudFrontSecurityHeadersConfig
  customHeadersConfig: { items: CloudFrontCustomHeader[] }
}

/**
 * Build the response-headers-policy body: the site's full security-header set
 * plus any `extra` headers (the `/media/*` behaviour adds `Cache-Control`).
 * Every entry sets `override: true` so an origin that happens to send one of
 * these (S3 never does) can never weaken the policy.
 *
 * Throws if ./headers.ts ever carries an `X-XSS-Protection` other than `0` — the
 * structured field has no way to express the legacy `1; mode=block` faithfully
 * AND that value is what OWASP now advises against; better a loud failure at
 * deploy time than a silently different header at the edge.
 */
export function cloudfrontResponseHeadersConfig(
  extra: SecurityHeader[] = [],
): CloudFrontResponseHeadersConfig {
  const xss = securityHeaders.find((h) => h.key.toLowerCase() === 'x-xss-protection')
  if (xss && xss.value.trim() !== '0') {
    throw new Error(
      `cloudfrontResponseHeadersConfig: X-XSS-Protection is "${xss.value}", but only "0" ` +
        'can be mirrored into a CloudFront response headers policy.',
    )
  }

  const custom: CloudFrontCustomHeader[] = [...securityHeaders, ...extra]
    .filter((h) => !STRUCTURED.has(h.key.toLowerCase()))
    .map((h) => ({ header: h.key, value: h.value, override: true as const }))

  return {
    securityHeadersConfig: {
      strictTransportSecurity: {
        accessControlMaxAgeSec: HSTS_MAX_AGE_SECONDS,
        includeSubdomains: HSTS_INCLUDE_SUBDOMAINS,
        preload: HSTS_PRELOAD,
        override: true,
      },
      contentTypeOptions: { override: true },
      frameOptions: { frameOption: FRAME_OPTIONS, override: true },
      referrerPolicy: { referrerPolicy: REFERRER_POLICY, override: true },
      xssProtection: { protection: false, override: true },
      contentSecurityPolicy: { contentSecurityPolicy: CONTENT_SECURITY_POLICY, override: true },
    },
    customHeadersConfig: { items: custom },
  }
}
