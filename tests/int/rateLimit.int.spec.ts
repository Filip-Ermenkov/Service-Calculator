// @vitest-environment node
import {
  ConditionalCheckFailedException,
  GetItemCommand,
  UpdateItemCommand,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  __resetRateLimitForTests,
  __setRateLimitStoreForTests,
  checkRateLimit,
  checkSlidingWindow,
  DynamoRateLimitStore,
  getClientIp,
  isDistributedRateLimitConfigured,
  rateLimitBucket,
  type RateLimitPolicy,
  type RateLimitStore,
} from '@/lib/rateLimit'
import { OPS_ALERT_MARKER } from '@/lib/observability/opsLog'

// Coverage for the shared rate limiter (AWS Well-Architected — Security /
// Cost-Optimization / Reliability) and its CloudFront-aware client-IP keying.
//
// Three layers, tested separately:
//   1. the in-memory sliding LOG used locally / in CI (RATE_LIMIT_TABLE unset —
//      true here per .env.example / ci.yml; the e2e counterpart proves the
//      running /api/quote and /api/contact routes return 429 on it);
//   2. the sliding-window COUNTER algorithm the deployed stages run, driven with a
//      fake store that honours the DynamoDB contract (a strongly consistent read;
//      an atomic "+1 iff below the limit" increment) and a fixed clock;
//   3. the DynamoDB store itself, against a stub client — asserting the exact
//      commands it issues, since that is the part staging is the only real proof of.
// Plus the wiring in between: pseudonymised buckets, and the OPS_ALERT +
// in-memory fallback when the shared store fails.

const QUOTE: RateLimitPolicy = { prefix: 'test-quote', max: 10, windowSeconds: 60 }
const TOTP_LIKE: RateLimitPolicy = { prefix: 'test-totp', max: 5, windowSeconds: 300 }

describe('checkRateLimit — in-memory fallback (src/lib/rateLimit.ts)', () => {
  beforeEach(() => {
    expect(process.env.RATE_LIMIT_TABLE).toBeUndefined()
    expect(isDistributedRateLimitConfigured()).toBe(false)
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

// ── The distributed algorithm ────────────────────────────────────────────────

/**
 * A store that honours exactly the contract src/lib/rateLimit.ts documents for
 * DynamoDB: `read` is consistent, `increment` is atomic and conditional on the
 * count BEFORE the add being `< limit`. Records every call so the tests can
 * assert what the algorithm asked for.
 */
class FakeStore implements RateLimitStore {
  counts = new Map<string, number>()
  expiries = new Map<string, number>()
  reads: Array<{ bucket: string; window: number }> = []
  increments: Array<{ bucket: string; window: number; limit: number; expiresAt: number }> = []

  private k(bucket: string, window: number) {
    return `${bucket}|${window}`
  }

  async read(bucket: string, window: number): Promise<number> {
    this.reads.push({ bucket, window })
    return this.counts.get(this.k(bucket, window)) ?? 0
  }

  async increment(bucket: string, window: number, limit: number, expiresAt: number) {
    this.increments.push({ bucket, window, limit, expiresAt })
    const key = this.k(bucket, window)
    const before = this.counts.get(key) ?? 0
    if (before >= limit) return { allowed: false, hits: before }
    this.counts.set(key, before + 1)
    if (!this.expiries.has(key)) this.expiries.set(key, expiresAt)
    return { allowed: true, hits: before + 1 }
  }
}

const WINDOW_MS = QUOTE.windowSeconds * 1000
/** A fixed "now" that sits `fraction` of the way into window index 1_000. */
const at = (fraction: number) => 1_000 * WINDOW_MS + Math.round(fraction * WINDOW_MS)

describe('checkSlidingWindow — the sliding-window counter deployed stages run', () => {
  it('allows exactly `max` events then blocks when the previous window is empty', async () => {
    const store = new FakeStore()
    for (let i = 1; i <= QUOTE.max; i++) {
      const r = await checkSlidingWindow(QUOTE, 'b', store, { now: at(0.5) })
      expect(r.success).toBe(true)
      expect(r.remaining).toBe(QUOTE.max - i)
    }
    const blocked = await checkSlidingWindow(QUOTE, 'b', store, { now: at(0.5) })
    expect(blocked).toEqual({ success: false, remaining: 0 })
    // Every decision read the PREVIOUS window and wrote the CURRENT one.
    expect(store.reads.every((r) => r.window === 999)).toBe(true)
    expect(store.increments.every((i) => i.window === 1_000)).toBe(true)
  })

  it('weights the previous window by how much of it still overlaps the trailing window', async () => {
    const store = new FakeStore()
    // The previous window was fully spent (10 hits). 25% into the current one,
    // 75% of it still counts: 10 × 0.75 = 7.5 ⇒ ceil(10 − 7.5) = 3 more allowed.
    store.counts.set('b|999', QUOTE.max)
    for (let i = 0; i < 3; i++) {
      expect((await checkSlidingWindow(QUOTE, 'b', store, { now: at(0.25) })).success).toBe(true)
    }
    expect((await checkSlidingWindow(QUOTE, 'b', store, { now: at(0.25) })).success).toBe(false)
    // The threshold is handed to the store's conditional increment — the
    // comparison happens atomically where the counter lives, not from the read.
    expect(store.increments.every((i) => i.limit === 3)).toBe(true)
  })

  it('at the boundary a saturated previous window blocks WITHOUT touching the counter', async () => {
    const store = new FakeStore()
    store.counts.set('b|999', QUOTE.max)
    const r = await checkSlidingWindow(QUOTE, 'b', store, { now: at(0) })
    expect(r).toEqual({ success: false, remaining: 0 })
    expect(store.increments).toHaveLength(0)
  })

  it('as the previous window ages out, budget returns (late in the window it no longer counts)', async () => {
    const store = new FakeStore()
    store.counts.set('b|999', QUOTE.max)
    // 99% through the current window: 10 × 0.01 = 0.1 ⇒ ceil(9.9) = 10 allowed.
    for (let i = 0; i < QUOTE.max; i++) {
      expect((await checkSlidingWindow(QUOTE, 'b', store, { now: at(0.99) })).success).toBe(true)
    }
    expect((await checkSlidingWindow(QUOTE, 'b', store, { now: at(0.99) })).success).toBe(false)
  })

  it('stamps each window item with a TTL that outlives its turn as the previous window', async () => {
    const store = new FakeStore()
    await checkSlidingWindow(QUOTE, 'b', store, { now: at(0.5) })
    // (current + 2) × windowSeconds, in epoch SECONDS (DynamoDB TTL's unit).
    expect(store.increments[0].expiresAt).toBe((1_000 + 2) * QUOTE.windowSeconds)
  })

  it('trusts the store’s conditional verdict — a concurrent instance can take the last token', async () => {
    // Two "instances" read the same state; the store (DynamoDB's atomic
    // conditional ADD) is what serialises them. Emulate the loser: the read said
    // there was budget, the increment says another instance used it first.
    const racing: RateLimitStore = {
      read: async () => 0,
      increment: async () => ({ allowed: false, hits: QUOTE.max }),
    }
    expect(await checkSlidingWindow(QUOTE, 'b', racing, { now: at(0.5) })).toEqual({
      success: false,
      remaining: 0,
    })
  })

  it('keys buckets and windows independently (different keys never share a counter)', async () => {
    const store = new FakeStore()
    for (let i = 0; i < QUOTE.max; i++) await checkSlidingWindow(QUOTE, 'a', store, { now: at(0.5) })
    expect((await checkSlidingWindow(QUOTE, 'a', store, { now: at(0.5) })).success).toBe(false)
    expect((await checkSlidingWindow(QUOTE, 'b', store, { now: at(0.5) })).success).toBe(true)
  })
})

// ── The wiring: pseudonymised buckets + fallback on failure ──────────────────

describe('rateLimitBucket — the table never holds a raw IP or email', () => {
  it('is prefix#hex(HMAC) — stable per key, distinct per key and per policy, and hides the key', () => {
    const ip = '203.0.113.7'
    const a = rateLimitBucket(QUOTE, ip)
    expect(a).toMatch(/^test-quote#[0-9a-f]{64}$/)
    expect(a).not.toContain(ip)
    expect(rateLimitBucket(QUOTE, ip)).toBe(a)
    expect(rateLimitBucket(QUOTE, '203.0.113.8')).not.toBe(a)
    expect(rateLimitBucket(TOTP_LIKE, ip)).not.toBe(a)
    const email = rateLimitBucket(QUOTE, 'email:someone@example.com')
    expect(email).not.toContain('someone')
    expect(email).not.toContain('example.com')
  })
})

describe('checkRateLimit — distributed path wiring (RATE_LIMIT_TABLE set)', () => {
  const OLD = process.env.RATE_LIMIT_TABLE

  beforeEach(() => {
    process.env.RATE_LIMIT_TABLE = 'unit-test-table'
    __resetRateLimitForTests()
  })
  afterEach(() => {
    __setRateLimitStoreForTests(null)
    if (OLD === undefined) delete process.env.RATE_LIMIT_TABLE
    else process.env.RATE_LIMIT_TABLE = OLD
    vi.restoreAllMocks()
  })

  it('uses the shared store with the pseudonymised bucket, not the in-memory log', async () => {
    const store = new FakeStore()
    __setRateLimitStoreForTests(store)
    expect(isDistributedRateLimitConfigured()).toBe(true)

    for (let i = 0; i < QUOTE.max; i++) {
      expect((await checkRateLimit(QUOTE, '203.0.113.7')).success).toBe(true)
    }
    expect((await checkRateLimit(QUOTE, '203.0.113.7')).success).toBe(false)

    expect(store.increments.length).toBeGreaterThan(0)
    expect(store.increments[0].bucket).toBe(rateLimitBucket(QUOTE, '203.0.113.7'))
    // The in-memory log was never consulted for this key (its budget is intact).
    delete process.env.RATE_LIMIT_TABLE
    expect((await checkRateLimit(QUOTE, '203.0.113.7')).success).toBe(true)
  })

  it('on a store failure it pages ONE OPS_ALERT and degrades to the in-memory limiter for that call', async () => {
    __setRateLimitStoreForTests({
      read: async () => {
        throw new Error('AccessDeniedException: not authorized to perform dynamodb:GetItem')
      },
      increment: async () => {
        throw new Error('unreachable')
      },
    })
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})

    // Still limited — per instance — exactly `max` then 429-worthy, never open.
    for (let i = 0; i < QUOTE.max; i++) {
      expect((await checkRateLimit(QUOTE, '198.51.100.1')).success).toBe(true)
    }
    expect((await checkRateLimit(QUOTE, '198.51.100.1')).success).toBe(false)

    // Every failed check emitted the alert marker the CloudWatch filter matches,
    // with the policy prefix as context and no personal data.
    const alerts = stderr.mock.calls
      .map((c) => String(c[0]))
      .filter((line) => line.startsWith(`${OPS_ALERT_MARKER} `))
    expect(alerts.length).toBe(QUOTE.max + 1)
    const parsed = JSON.parse(alerts[0].slice(OPS_ALERT_MARKER.length + 1)) as Record<string, unknown>
    expect(parsed.scope).toBe('rateLimit.dynamodb')
    expect(parsed.severity).toBe('error')
    expect(parsed.prefix).toBe(QUOTE.prefix)
    expect(String(parsed.message)).toContain('AccessDeniedException')
    expect(alerts[0]).not.toContain('198.51.100.1')
  })
})

// ── The DynamoDB store, against a stub client ────────────────────────────────

describe('DynamoRateLimitStore — the exact commands it issues', () => {
  type Sent = GetItemCommand | UpdateItemCommand
  function stubClient(handler: (cmd: Sent) => Promise<unknown>) {
    const sent: Sent[] = []
    const client = {
      send: async (cmd: Sent) => {
        sent.push(cmd)
        return handler(cmd)
      },
    } as unknown as DynamoDBClient
    return { client, sent }
  }

  it('read: a strongly consistent GetItem on (pk, sk), 0 when the item is absent', async () => {
    const { client, sent } = stubClient(async (cmd) =>
      cmd instanceof GetItemCommand && cmd.input.Key?.sk?.S === 'w#41'
        ? { Item: { hits: { N: '7' } } }
        : { Item: undefined },
    )
    const store = new DynamoRateLimitStore('t', client)
    expect(await store.read('p#abc', 41)).toBe(7)
    expect(await store.read('p#abc', 40)).toBe(0)

    const first = sent[0] as GetItemCommand
    expect(first.input).toMatchObject({
      TableName: 't',
      Key: { pk: { S: 'p#abc' }, sk: { S: 'w#41' } },
      ConsistentRead: true,
      ProjectionExpression: 'hits',
    })
  })

  it('increment: a conditional atomic ADD that stamps the TTL once and returns the new count', async () => {
    const { client, sent } = stubClient(async () => ({ Attributes: { hits: { N: '3' } } }))
    const store = new DynamoRateLimitStore('t', client)
    expect(await store.increment('p#abc', 41, 10, 123_456)).toEqual({ allowed: true, hits: 3 })

    const cmd = sent[0] as UpdateItemCommand
    expect(cmd).toBeInstanceOf(UpdateItemCommand)
    expect(cmd.input).toMatchObject({
      TableName: 't',
      Key: { pk: { S: 'p#abc' }, sk: { S: 'w#41' } },
      UpdateExpression: 'SET expiresAt = if_not_exists(expiresAt, :exp) ADD hits :one',
      ConditionExpression: 'attribute_not_exists(hits) OR hits < :limit',
      ExpressionAttributeValues: {
        ':one': { N: '1' },
        ':exp': { N: '123456' },
        ':limit': { N: '10' },
      },
      ReturnValues: 'ALL_NEW',
    })
  })

  it('increment: a failed condition is "no budget", not an error; anything else propagates', async () => {
    const { client: full } = stubClient(async () => {
      throw new ConditionalCheckFailedException({ message: 'The conditional request failed', $metadata: {} })
    })
    expect(await new DynamoRateLimitStore('t', full).increment('p#abc', 41, 10, 1)).toEqual({
      allowed: false,
      hits: 10,
    })

    const { client: broken } = stubClient(async () => {
      throw new Error('ResourceNotFoundException')
    })
    await expect(new DynamoRateLimitStore('t', broken).increment('p#abc', 41, 10, 1)).rejects.toThrow(
      'ResourceNotFoundException',
    )
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
