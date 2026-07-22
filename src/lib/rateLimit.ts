import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'

/**
 * Generic sliding-window rate limiter (AWS Well-Architected — Security,
 * Cost-Optimization, and Reliability pillars).
 *
 * Extracted from the original TOTP-only limiter so it can protect any endpoint
 * that must not be hammered: the TOTP verify/enroll steps (5 / 5 min) and the
 * public `/api/quote` PDF endpoint (which invokes a 1600 MB Chromium Lambda +
 * a Neon query on every call — an unauthenticated, expensive resource that a
 * scripted loop could otherwise use to run up AWS cost or exhaust capacity).
 *
 * Real Upstash Redis (the project's chosen tool — serverless, pay-per-request,
 * REST-friendly) is used whenever `UPSTASH_REDIS_REST_URL` /
 * `UPSTASH_REDIS_REST_TOKEN` are configured — required in staging/production,
 * where it is the *only* multi-instance-safe option (a distributed counter
 * shared across all Lambda instances).
 *
 * When those env vars are absent (local dev without an Upstash account, and
 * CI), this falls back to a single-process in-memory sliding window. This
 * mirrors the project's S3Mock-over-real-AWS pattern for local/CI — tests and
 * local development shouldn't require a live third-party account. The in-memory
 * fallback is NOT safe for a real multi-instance deployment (each Lambda cold
 * start gets its own counters, so it under-limits) and must never be relied on
 * outside local/test — a warning is logged once if it activates outside those.
 */

/** A named rate-limit policy: `max` events per `windowSeconds`, isolated by `prefix`. */
export interface RateLimitPolicy {
  /** Upstash key namespace + in-memory key namespace (keeps endpoints isolated). */
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

function hasUpstashConfig(): boolean {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
}

let warnedAboutFallback = false
function warnFallbackIfNeeded() {
  if (warnedAboutFallback) return
  warnedAboutFallback = true
  const env = process.env.NODE_ENV
  if (env !== 'test' && env !== 'development') {
    console.warn(
      '[rateLimit] UPSTASH_REDIS_REST_URL/TOKEN not set — falling back to an in-memory ' +
        'rate limiter. This is only appropriate for local development and tests; configure ' +
        'real Upstash credentials in staging/production (see .env.example).',
    )
  }
}

// One Upstash limiter per policy prefix (constructing a Ratelimit is cheap but
// caching avoids rebuilding it on every request).
const upstashLimiters = new Map<string, Ratelimit>()
function getUpstashLimiter(policy: RateLimitPolicy): Ratelimit {
  let limiter = upstashLimiters.get(policy.prefix)
  if (!limiter) {
    limiter = new Ratelimit({
      redis: Redis.fromEnv(),
      limiter: Ratelimit.slidingWindow(policy.max, `${policy.windowSeconds} s`),
      analytics: false,
      prefix: policy.prefix,
    })
    upstashLimiters.set(policy.prefix, limiter)
  }
  return limiter
}

// --- In-memory fallback (local/CI only) ---
// Keyed by `${prefix}:${key}` so different policies/endpoints never collide.
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
 * window. Uses real Upstash when configured, else the in-memory fallback.
 */
export async function checkRateLimit(
  policy: RateLimitPolicy,
  key: string,
): Promise<RateLimitResult> {
  if (hasUpstashConfig()) {
    const { success, remaining } = await getUpstashLimiter(policy).limit(key)
    return { success, remaining }
  }

  warnFallbackIfNeeded()
  return checkInMemory(policy, key)
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
 */
export function getClientIp(request: Request): string {
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
