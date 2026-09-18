import { createHmac } from 'crypto'

import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb'

import { logOpsEvent } from './observability/opsLog'
import { getRateLimitBucketKey } from './totp/keys'

/**
 * Generic sliding-window rate limiter (AWS Well-Architected — Security,
 * Cost-Optimization, and Reliability pillars).
 *
 * One limiter, several policies: the TOTP verify/enrol steps (5 / 5 min), the
 * public `/api/quote` PDF endpoint (10 / min / IP — every call is a Neon read +
 * a 1600 MB Chromium Lambda), `/api/contact` (5 / min / IP — an outbound SES
 * send) and `/api/users/forgot-password` (5 / 15 min per IP and per address).
 *
 * ── Where the counters live ──────────────────────────────────────────────────
 * On a deployed stage the counters are shared across every Lambda instance
 * through a small **DynamoDB** table (`RATE_LIMIT_TABLE`, created by
 * `sst.config.ts`; the execution role carries `GetItem` + `UpdateItem` on it).
 * That is what makes a limit a limit on Lambda: each concurrent request runs in
 * its own instance, so any per-process counter is silently multiplied by the
 * account's concurrency and reset on every cold start — which is exactly what
 * both stages were doing from 2026-07 to 2026-09-18, because the limiter this
 * replaced (Upstash Redis) had never been given credentials.
 *
 * WHY DYNAMODB, not Upstash (decided 2026-09-18 — the same reasoning that chose
 * AWS Translate over DeepL): it runs in this account and region (the counters
 * are keyed by visitor IP addresses and reset-request email addresses — personal
 * data under GDPR — so they stay in eu-central-1 under the existing AWS DPA
 * instead of at a new sub-processor whose free tier has no encryption at rest);
 * it authenticates with the execution role (no secret to set, leak or rotate);
 * it has no free-tier terms to change under the project (the DeepL / MinIO /
 * LocalStack lesson); and at this traffic it costs cents (one strongly-
 * consistent read + one conditional write per check, on-demand billing, items
 * expire by TTL). The keys are additionally **pseudonymised**: the table holds
 * `prefix#HMAC-SHA256(key)` under a key derived from `TOTP_ENCRYPTION_KEY`, so a
 * raw IP or email is never written to it.
 *
 * ALGORITHM: the "sliding window counter" (Cloudflare's, and what the previous
 * Upstash limiter used) — a fixed-window counter per `(bucket, window)` item,
 * with the previous window's count weighted by how much of it still overlaps
 * the trailing window: `allowed ⇔ previous × weight + current < max`. It is an
 * approximation at a window boundary by at most one request, costs exactly one
 * read + one write, and needs no list manipulation or transactions. The write
 * is a conditional atomic `ADD`, so concurrent checks from many instances can
 * never both pass on the last token.
 *
 * FAILURE POLICY (the never-throws contract every AWS-touching module here
 * keeps): the DynamoDB path is time-boxed, and if it fails — a permission
 * missing, the table gone, an AWS outage — the check logs ONE `OPS_ALERT`
 * (`rateLimit.dynamodb`, it pages: a limiter that stopped sharing state is a
 * security regression an operator must know about) and falls back to the
 * per-instance in-memory limiter below for that call. Degraded, never open.
 *
 * ── Local dev, CI and tests ──────────────────────────────────────────────────
 * With `RATE_LIMIT_TABLE` unset (the local `.env`, `ci.yml`) the limiter is the
 * single-process in-memory sliding log below — exact, and the right thing for a
 * one-process dev server or test runner, which is why the e2e 429 assertions can
 * count requests precisely. It mirrors the project's S3Mock-over-real-AWS pattern:
 * nothing local needs AWS access. It is NOT safe on Lambda (see above), and a
 * warning is logged once if it activates outside dev/test.
 */

/** A named rate-limit policy: `max` events per `windowSeconds`, isolated by `prefix`. */
export interface RateLimitPolicy {
  /** Key namespace (DynamoDB partition-key prefix + in-memory map prefix) — keeps endpoints isolated. */
  prefix: string
  /** Maximum allowed events in the trailing window. */
  max: number
  /** Sliding-window length, in seconds. */
  windowSeconds: number
}

export interface RateLimitResult {
  success: boolean
  remaining: number
}

/**
 * The shared counter store behind the sliding window. Two implementations:
 * DynamoDB (deployed stages) and the test double in tests/int/rateLimit.int.spec.ts.
 * The contract each method must honour is what makes the algorithm correct:
 *   • `read` returns the count recorded for (bucket, window), 0 when absent, and
 *     must be strongly consistent (a stale previous-window count under-limits).
 *   • `increment` adds ONE to (bucket, window) **atomically and only if** the
 *     count before the add is `< limit`; it reports the count after the add.
 */
export interface RateLimitStore {
  read(bucket: string, window: number, signal?: AbortSignal): Promise<number>
  increment(
    bucket: string,
    window: number,
    limit: number,
    expiresAt: number,
    signal?: AbortSignal,
  ): Promise<{ allowed: boolean; hits: number }>
}

/** Name of the DynamoDB table (set by sst.config.ts on deployed stages), or null. */
export function getRateLimitTable(): string | null {
  const value = process.env.RATE_LIMIT_TABLE?.trim()
  return value ? value : null
}

/** True when the shared DynamoDB store is wired for this process. */
export function isDistributedRateLimitConfigured(): boolean {
  return getRateLimitTable() !== null
}

/**
 * The partition key for one (policy, key) pair. The policy prefix stays readable
 * (it is not personal and it is what an operator would group by); the key —
 * an IP address, an email address, a user id — is replaced by a keyed hash so
 * the table never holds it. A keyed HMAC rather than a plain SHA-256 because an
 * IPv4 space is small enough to reverse a plain hash by brute force.
 */
export function rateLimitBucket(policy: RateLimitPolicy, key: string): string {
  const digest = createHmac('sha256', getRateLimitBucketKey()).update(key).digest('hex')
  return `${policy.prefix}#${digest}`
}

/**
 * The sliding-window decision, pure apart from the store calls (exported for the
 * unit tests, which drive it with a fake store and a fixed clock).
 *
 * `window` indexes are `floor(now / windowMs)`; the previous window's count is
 * weighted by the fraction of it that still falls inside the trailing window.
 * `allowed ⇔ previous × weight + current < max`, i.e. the current window may
 * hold at most `ceil(max − previous × weight)` events — that ceiling is the
 * `limit` handed to the store's conditional increment, so the comparison is
 * made atomically where the counter lives, not from a stale read.
 */
export async function checkSlidingWindow(
  policy: RateLimitPolicy,
  bucket: string,
  store: RateLimitStore,
  options: { now?: number; signal?: AbortSignal } = {},
): Promise<RateLimitResult> {
  const now = options.now ?? Date.now()
  const windowMs = policy.windowSeconds * 1000
  const current = Math.floor(now / windowMs)
  const elapsedMs = now - current * windowMs
  const previousWeight = (windowMs - elapsedMs) / windowMs

  const previousHits = await store.read(bucket, current - 1, options.signal)
  const limit = Math.ceil(policy.max - previousHits * previousWeight)
  if (limit <= 0) return { success: false, remaining: 0 }

  // The item must outlive its turn as the "previous" window, plus DynamoDB's
  // own TTL lag; expired items are never read (windows are keyed), only swept.
  const expiresAt = (current + 2) * policy.windowSeconds
  const { allowed, hits } = await store.increment(
    bucket,
    current,
    limit,
    expiresAt,
    options.signal,
  )
  if (!allowed) return { success: false, remaining: 0 }
  return { success: true, remaining: Math.max(0, limit - hits) }
}

// ── DynamoDB store (deployed stages) ─────────────────────────────────────────

/** Hard ceiling on the read + write together; a hang must never stall a request. */
const DYNAMO_DEADLINE_MS = 1_500

let client: DynamoDBClient | null = null
function getClient(): DynamoDBClient {
  if (!client) {
    client = new DynamoDBClient({
      region: process.env.AWS_REGION || 'eu-central-1',
      maxAttempts: 2,
    })
  }
  return client
}

function windowKey(bucket: string, window: number) {
  return { pk: { S: bucket }, sk: { S: `w#${window}` } }
}

export class DynamoRateLimitStore implements RateLimitStore {
  constructor(
    private readonly table: string,
    private readonly dynamo: DynamoDBClient = getClient(),
  ) {}

  async read(bucket: string, window: number, signal?: AbortSignal): Promise<number> {
    const res = await this.dynamo.send(
      new GetItemCommand({
        TableName: this.table,
        Key: windowKey(bucket, window),
        // Strongly consistent: an eventually-consistent read of the previous
        // window could miss its last increments and under-limit.
        ConsistentRead: true,
        ProjectionExpression: 'hits',
      }),
      { abortSignal: signal },
    )
    return Number(res.Item?.hits?.N ?? 0)
  }

  async increment(
    bucket: string,
    window: number,
    limit: number,
    expiresAt: number,
    signal?: AbortSignal,
  ): Promise<{ allowed: boolean; hits: number }> {
    try {
      const res = await this.dynamo.send(
        new UpdateItemCommand({
          TableName: this.table,
          Key: windowKey(bucket, window),
          // Atomic counter (ADD) + the TTL stamped once, on the item's creation.
          UpdateExpression: 'SET expiresAt = if_not_exists(expiresAt, :exp) ADD hits :one',
          // The whole point: the "is there budget left?" comparison happens
          // inside DynamoDB's atomic update, so N concurrent instances can never
          // all pass on the last token.
          ConditionExpression: 'attribute_not_exists(hits) OR hits < :limit',
          ExpressionAttributeValues: {
            ':one': { N: '1' },
            ':exp': { N: String(expiresAt) },
            ':limit': { N: String(limit) },
          },
          ReturnValues: 'ALL_NEW',
        }),
        { abortSignal: signal },
      )
      return { allowed: true, hits: Number(res.Attributes?.hits?.N ?? 1) }
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        return { allowed: false, hits: limit }
      }
      throw err
    }
  }
}

/**
 * Test seam (mirrors __set…ForTests in ses.ts / cdn/invalidate.ts): when set, it
 * replaces the DynamoDB store so the distributed path — the sliding-window
 * arithmetic, the pseudonymised buckets and the failure fallback — can be
 * exercised with no AWS access. Only consulted when `RATE_LIMIT_TABLE` is set.
 */
let storeForTests: RateLimitStore | null = null
export function __setRateLimitStoreForTests(store: RateLimitStore | null): void {
  storeForTests = store
}

// ── In-memory fallback (local/CI, and the degraded path) ─────────────────────

let warnedAboutFallback = false
function warnFallbackIfNeeded() {
  if (warnedAboutFallback) return
  warnedAboutFallback = true
  const env = process.env.NODE_ENV
  if (env !== 'test' && env !== 'development') {
    console.warn(
      '[rateLimit] RATE_LIMIT_TABLE is not set — falling back to an in-memory rate limiter. ' +
        'This is only appropriate for local development and tests; a deployed stage gets ' +
        'the DynamoDB table from sst.config.ts automatically (see .env.example).',
    )
  }
}

// An exact sliding log, keyed by `${prefix}:${key}` so policies never collide.
const memoryHits = new Map<string, number[]>()

function checkInMemory(policy: RateLimitPolicy, key: string): RateLimitResult {
  const now = Date.now()
  const windowStart = now - policy.windowSeconds * 1000
  const mapKey = `${policy.prefix}:${key}`
  const existing = (memoryHits.get(mapKey) ?? []).filter((ts) => ts > windowStart)

  if (existing.length >= policy.max) {
    memoryHits.set(mapKey, existing)
    return { success: false, remaining: 0 }
  }

  existing.push(now)
  memoryHits.set(mapKey, existing)
  return { success: true, remaining: policy.max - existing.length }
}

/** Resets in-memory counters. Test-only helper. */
export function __resetRateLimitForTests(): void {
  memoryHits.clear()
}

/**
 * Checks and consumes one event against `policy` for `key`. Returns
 * `success: false` once `key` has reached `policy.max` within the trailing
 * window. Uses the shared DynamoDB store when configured (falling back, with an
 * `OPS_ALERT`, to the in-memory limiter if that store fails), else in-memory.
 */
export async function checkRateLimit(
  policy: RateLimitPolicy,
  key: string,
): Promise<RateLimitResult> {
  const table = getRateLimitTable()
  if (!table) {
    warnFallbackIfNeeded()
    return checkInMemory(policy, key)
  }

  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new Error('rate-limit store timed out')),
    DYNAMO_DEADLINE_MS,
  )
  try {
    const store = storeForTests ?? new DynamoRateLimitStore(table)
    return await checkSlidingWindow(policy, rateLimitBucket(policy, key), store, {
      signal: controller.signal,
    })
  } catch (err) {
    // The shared store is unreachable or misconfigured: page (this is a
    // security regression, not a self-healing blip) and degrade to the
    // per-instance limiter rather than failing the request open OR closed.
    logOpsEvent('rateLimit.dynamodb', err, 'error', { prefix: policy.prefix })
    return checkInMemory(policy, key)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Best-effort client IP for rate-limit keying, hardened for this app's
 * CloudFront → OpenNext/Lambda topology.
 *
 * Order of preference:
 *  1. `CloudFront-Viewer-Address` — set by CloudFront itself from the TCP
 *     connection, so it CANNOT be spoofed by a client prepending its own
 *     `X-Forwarded-For` (the documented weakness of XFF behind a CDN). It is
 *     `IP:port` (IPv4) or `[v6]:port`, so the trailing `:port` is stripped.
 *     NB: this header must be forwarded to the origin by the CloudFront
 *     distribution to be present — see the infra note in the E2E guide/docs;
 *     the code degrades gracefully to XFF when it isn't.
 *  2. `X-Forwarded-For` — comma-separated hop list. The leftmost entry is
 *     client-controlled (spoofable); the value CloudFront appends is the real
 *     viewer, so we take the LAST entry as the more trustworthy one here.
 *  3. `x-real-ip`, then a constant fallback bucket so an IP-less request is
 *     still rate-limited (fail-safe, never fail-open).
 *
 * Verified empirically against the production CloudFront distribution
 * (2026-09-13): a viewer-supplied `CloudFront-Viewer-Address` or `X-Real-IP` is
 * STRIPPED by CloudFront, and a viewer-supplied `X-Forwarded-For` has the true
 * TCP-source IP appended as the LAST hop — so none of the three can be used to
 * rotate out of a bucket. Accepts anything with a `headers` map (a Fetch
 * `Request` or a Payload `PayloadRequest`), so the TOTP endpoints and the public
 * routes share one IP definition.
 */
export function getClientIp(request: { headers: Headers }): string {
  const viewer = request.headers.get('cloudfront-viewer-address')
  if (viewer) {
    // Strip the trailing ":port". IPv6 is bracketed ("[2001:db8::1]:443").
    const v6 = /^\[(.+)\]:\d+$/.exec(viewer)
    if (v6) return v6[1]
    const lastColon = viewer.lastIndexOf(':')
    return lastColon > 0 ? viewer.slice(0, lastColon) : viewer
  }

  const xff = request.headers.get('x-forwarded-for')
  if (xff) {
    const parts = xff
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
    if (parts.length > 0) return parts[parts.length - 1]
  }

  const realIp = request.headers.get('x-real-ip')
  if (realIp) return realIp.trim()

  return 'unknown'
}
