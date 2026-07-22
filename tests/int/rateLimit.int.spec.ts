import { beforeEach, describe, expect, it } from 'vitest'

import {
  __resetRateLimitForTests,
  checkRateLimit,
  getClientIp,
  type RateLimitPolicy,
} from '@/lib/rateLimit'

// Pure coverage for the shared rate limiter (AWS Well-Architected — Security /
// Cost-Optimization / Reliability) and its CloudFront-aware client-IP keying.
// These rely on UPSTASH_REDIS_REST_URL/TOKEN being unset (true for local dev and
// CI per .env.example / ci.yml), so checkRateLimit exercises the in-memory
// fallback, not real Upstash. The e2e counterpart proves the running /api/quote
// route actually returns 429 once the per-IP budget is spent.

const QUOTE: RateLimitPolicy = { prefix: 'test-quote', max: 10, windowSeconds: 60 }
const TOTP_LIKE: RateLimitPolicy = { prefix: 'test-totp', max: 5, windowSeconds: 300 }

describe('checkRateLimit — in-memory fallback (src/lib/rateLimit.ts)', () => {
  beforeEach(() => {
    expect(process.env.UPSTASH_REDIS_REST_URL).toBeUndefined()
    __resetRateLimitForTests()
  })

  it('allows exactly `max` events then blocks, decrementing remaining', async () => {
    const key = '203.0.113.10'
    for (let i = 1; i <= QUOTE.max; i++) {
      const r = await checkRateLimit(QUOTE, key)
      expect(r.success).toBe(true)
      expect(r.remaining).toBe(QUOTE.max - i)
    }
    const blocked = await checkRateLimit(QUOTE, key)
    expect(blocked.success).toBe(false)
    expect(blocked.remaining).toBe(0)
  })

  it('tracks separate keys (IPs) independently', async () => {
    const a = '1.1.1.1'
    const b = '2.2.2.2'
    for (let i = 0; i < QUOTE.max; i++) expect((await checkRateLimit(QUOTE, a)).success).toBe(true)
    expect((await checkRateLimit(QUOTE, a)).success).toBe(false)
    // A different IP has its own untouched budget.
    expect((await checkRateLimit(QUOTE, b)).success).toBe(true)
  })

  it('isolates policies by prefix — the same key does not collide across endpoints', async () => {
    const key = 'shared-key'
    // Spend the whole quote budget for this key…
    for (let i = 0; i < QUOTE.max; i++) expect((await checkRateLimit(QUOTE, key)).success).toBe(true)
    expect((await checkRateLimit(QUOTE, key)).success).toBe(false)
    // …the TOTP-like policy with the SAME key is unaffected (different prefix).
    for (let i = 0; i < TOTP_LIKE.max; i++)
      expect((await checkRateLimit(TOTP_LIKE, key)).success).toBe(true)
    expect((await checkRateLimit(TOTP_LIKE, key)).success).toBe(false)
  })

  it('__resetRateLimitForTests clears all counters', async () => {
    const key = 'reset-me'
    for (let i = 0; i < QUOTE.max; i++) await checkRateLimit(QUOTE, key)
    expect((await checkRateLimit(QUOTE, key)).success).toBe(false)
    __resetRateLimitForTests()
    expect((await checkRateLimit(QUOTE, key)).success).toBe(true)
  })
})

describe('getClientIp — CloudFront-aware, spoof-resistant keying', () => {
  const req = (headers: Record<string, string>) => new Request('https://x/api/quote', { headers })

  it('prefers CloudFront-Viewer-Address and strips the :port (IPv4)', () => {
    expect(getClientIp(req({ 'cloudfront-viewer-address': '203.0.113.7:52000' }))).toBe('203.0.113.7')
  })

  it('handles a bracketed IPv6 CloudFront-Viewer-Address', () => {
    expect(getClientIp(req({ 'cloudfront-viewer-address': '[2001:db8::1]:443' }))).toBe('2001:db8::1')
  })

  it('prefers CloudFront-Viewer-Address over a spoofable X-Forwarded-For', () => {
    expect(
      getClientIp(
        req({ 'cloudfront-viewer-address': '203.0.113.7:1', 'x-forwarded-for': '6.6.6.6' }),
      ),
    ).toBe('203.0.113.7')
  })

  it('falls back to the LAST X-Forwarded-For hop (the CDN-appended viewer)', () => {
    expect(getClientIp(req({ 'x-forwarded-for': '1.1.1.1, 203.0.113.7' }))).toBe('203.0.113.7')
  })

  it('falls back to x-real-ip, then a constant fail-safe bucket', () => {
    expect(getClientIp(req({ 'x-real-ip': '4.4.4.4' }))).toBe('4.4.4.4')
    // No usable header → a single shared bucket so the request is still limited
    // (fail-safe, never fail-open).
    expect(getClientIp(req({}))).toBe('unknown')
  })
})
