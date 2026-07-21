import { describe, expect, it } from 'vitest'

import {
  CONTENT_SECURITY_POLICY,
  PERMISSIONS_POLICY,
  securityHeaders,
} from '@/lib/security/headers'

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
