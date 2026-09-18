import { describe, expect, it } from 'vitest'

import {
  CONTENT_SECURITY_POLICY,
  HSTS_MAX_AGE_SECONDS,
  PERMISSIONS_POLICY,
  securityHeaders,
} from '@/lib/security/headers'
import { cloudfrontResponseHeadersConfig } from '@/lib/security/cloudfrontResponseHeaders'
import { MEDIA_CACHE_CONTROL } from '@/lib/media/publicUrl'

// Pure coverage for the security-header set (AWS Well-Architected — Security;
// OWASP Secure Headers). Asserts the exact keys/values that next.config.ts
// serves on every route, so a regression to the shared module fails CI here
// (the e2e counterpart proves the running server actually emits them).

/** Convenience: look a header value up by (case-insensitive) key. */
function headerValue(key: string): string | undefined {
  return securityHeaders.find((h) => h.key.toLowerCase() === key.toLowerCase())?.value
}

describe('security headers — shared module', () => {
  it('exposes every OWASP core / high-value header exactly once', () => {
    const keys = securityHeaders.map((h) => h.key.toLowerCase())
    const expected = [
      'strict-transport-security',
      'x-content-type-options',
      'referrer-policy',
      'x-frame-options',
      'x-xss-protection',
      'x-permitted-cross-domain-policies',
      'cross-origin-opener-policy',
      'permissions-policy',
      'content-security-policy',
    ]
    for (const key of expected) expect(keys).toContain(key)
    // No accidental duplicates (a duplicate would be a config smell / ambiguity).
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('HSTS uses the OWASP 2-year max-age with subdomains, and no premature preload', () => {
    const hsts = headerValue('Strict-Transport-Security')!
    const maxAge = Number(/max-age=(\d+)/.exec(hsts)?.[1])
    expect(maxAge).toBeGreaterThanOrEqual(63072000)
    expect(hsts).toContain('includeSubDomains')
    // `preload` is deliberately withheld until the real custom domain (a shared
    // *.cloudfront.net host cannot be preloaded).
    expect(hsts).not.toContain('preload')
  })

  it('sets the safe scalar headers to their recommended values', () => {
    expect(headerValue('X-Content-Type-Options')).toBe('nosniff')
    expect(headerValue('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
    expect(headerValue('X-Frame-Options')).toBe('SAMEORIGIN')
    expect(headerValue('X-XSS-Protection')).toBe('0')
    expect(headerValue('X-Permitted-Cross-Domain-Policies')).toBe('none')
    expect(headerValue('Cross-Origin-Opener-Policy')).toBe('same-origin')
  })

  it('CSP enforces the nonce-free directives and omits the ones that need a nonce', () => {
    const csp = headerValue('Content-Security-Policy')!
    expect(csp).toBe(CONTENT_SECURITY_POLICY)
    expect(csp).toContain("base-uri 'self'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("frame-ancestors 'self'")
    expect(csp).toContain("form-action 'self'")
    // These would break the Payload admin / inline styles without per-request
    // nonces, so they are intentionally NOT enforced in this slice.
    expect(csp).not.toContain('script-src')
    expect(csp).not.toContain('style-src')
    expect(csp).not.toContain('default-src')
    // upgrade-insecure-requests is omitted so local http dev is not broken.
    expect(csp).not.toContain('upgrade-insecure-requests')
  })

  it('Permissions-Policy disables the powerful features the site never uses', () => {
    const pp = headerValue('Permissions-Policy')!
    expect(pp).toBe(PERMISSIONS_POLICY)
    for (const feature of ['camera=()', 'microphone=()', 'geolocation=()', 'payment=()']) {
      expect(pp).toContain(feature)
    }
  })
})

// The same header set, projected into a CloudFront response-headers policy for
// the `/media/*` behaviour (src/lib/security/cloudfrontResponseHeaders.ts):
// those responses come from S3 and never pass through Next, so this mapping is
// the only thing standing between an image response and a bare header set. The
// assertions below tie every field back to the `securityHeaders` list, so a
// change to one surface that is not mirrored on the other fails here.
describe('security headers — CloudFront response-headers-policy projection (/media/*)', () => {
  const projected = cloudfrontResponseHeadersConfig([
    { key: 'Cache-Control', value: MEDIA_CACHE_CONTROL },
  ])
  const custom = (key: string) =>
    projected.customHeadersConfig.items.find((h) => h.header.toLowerCase() === key.toLowerCase())

  it('carries the structured headers with the exact values Next serves', () => {
    const sec = projected.securityHeadersConfig
    // HSTS: the structured form must reassemble to the literal header string.
    const hsts = sec.strictTransportSecurity
    const reassembled = [
      `max-age=${hsts.accessControlMaxAgeSec}`,
      ...(hsts.includeSubdomains ? ['includeSubDomains'] : []),
      ...(hsts.preload ? ['preload'] : []),
    ].join('; ')
    expect(reassembled).toBe(headerValue('Strict-Transport-Security'))
    expect(hsts.accessControlMaxAgeSec).toBe(HSTS_MAX_AGE_SECONDS)

    expect(sec.contentTypeOptions).toEqual({ override: true }) // → X-Content-Type-Options: nosniff
    expect(sec.frameOptions.frameOption).toBe(headerValue('X-Frame-Options'))
    expect(sec.referrerPolicy.referrerPolicy).toBe(headerValue('Referrer-Policy'))
    expect(sec.contentSecurityPolicy.contentSecurityPolicy).toBe(headerValue('Content-Security-Policy'))
    // `protection: false` is CloudFront's spelling of `X-XSS-Protection: 0`.
    expect(headerValue('X-XSS-Protection')).toBe('0')
    expect(sec.xssProtection.protection).toBe(false)
  })

  it('every header CloudFront cannot take structurally rides along as a custom header', () => {
    for (const key of [
      'Permissions-Policy',
      'Cross-Origin-Opener-Policy',
      'X-Permitted-Cross-Domain-Policies',
    ]) {
      expect(custom(key)?.value).toBe(headerValue(key))
    }
    // …and the structured ones are NOT duplicated as custom headers (CloudFront
    // rejects that at deploy time).
    for (const key of [
      'Strict-Transport-Security',
      'X-Content-Type-Options',
      'X-Frame-Options',
      'Referrer-Policy',
      'X-XSS-Protection',
      'Content-Security-Policy',
    ]) {
      expect(custom(key)).toBeUndefined()
    }
  })

  it('adds the browser Cache-Control for media and overrides whatever the origin sends', () => {
    expect(custom('Cache-Control')?.value).toBe(MEDIA_CACHE_CONTROL)
    for (const item of projected.customHeadersConfig.items) expect(item.override).toBe(true)
    for (const field of Object.values(projected.securityHeadersConfig)) {
      expect((field as { override: boolean }).override).toBe(true)
    }
  })

  it('nothing in the projection is lost or invented: header count matches the source set + extras', () => {
    const structuredCount = Object.keys(projected.securityHeadersConfig).length
    const customCount = projected.customHeadersConfig.items.length
    expect(structuredCount + customCount).toBe(securityHeaders.length + 1)
  })
})
