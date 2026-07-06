import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'

/**
 * Rate limiting / lockout for the TOTP verification and enrollment steps
 * (distinct from Payload's own built-in password-attempt lockout — see
 * `auth.maxLoginAttempts`/`auth.lockTime` on the Users collection — this
 * covers brute-forcing a 6-digit code once past the password step).
 *
 * Real Upstash Redis (docs/TECHSPEC.md's chosen tool — serverless,
 * pay-per-request, REST-friendly, confirmed still on a viable free tier as
 * of this writing) is used whenever `UPSTASH_REDIS_REST_URL` /
 * `UPSTASH_REDIS_REST_TOKEN` are configured — required in staging/production.
 *
 * When those env vars are absent (local dev without an Upstash account yet,
 * and CI), this falls back to a single-process in-memory sliding-window
 * limiter. This mirrors the project's existing S3Mock-over-real-AWS pattern
 * for local/CI (docs/PROGRESS.md) — tests and local development shouldn't
 * require a live third-party account. The in-memory fallback is NOT safe
 * for a real multi-instance deployment (each Lambda cold start gets its own
 * counters, so it under-limits) and must never be relied on outside
 * local/test — a warning is logged once if it activates outside those.
 */

const WINDOW = '5 m'
const MAX_ATTEMPTS = 5

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
      '[totp/rateLimit] UPSTASH_REDIS_REST_URL/TOKEN not set — falling back to an in-memory ' +
        'rate limiter. This is only appropriate for local development and tests; configure ' +
        'real Upstash credentials in staging/production (see .env.example).',
    )
  }
}

let upstashLimiter: Ratelimit | null = null
function getUpstashLimiter(): Ratelimit {
  if (!upstashLimiter) {
    upstashLimiter = new Ratelimit({
      redis: Redis.fromEnv(),
      limiter: Ratelimit.slidingWindow(MAX_ATTEMPTS, WINDOW),
      analytics: false,
      prefix: 'bulbau-totp',
    })
  }
  return upstashLimiter
}

// --- In-memory fallback (local/CI only) ---
const WINDOW_MS = 5 * 60 * 1000
const memoryHits = new Map<string, number[]>()

function checkInMemory(key: string): { success: boolean; remaining: number } {
  const now = Date.now()
  const windowStart = now - WINDOW_MS
  const existing = (memoryHits.get(key) ?? []).filter((ts) => ts > windowStart)

  if (existing.length >= MAX_ATTEMPTS) {
    memoryHits.set(key, existing)
    return { success: false, remaining: 0 }
  }

  existing.push(now)
  memoryHits.set(key, existing)
  return { success: true, remaining: MAX_ATTEMPTS - existing.length }
}

/** Resets in-memory counters. Test-only helper. */
export function __resetInMemoryRateLimitForTests(): void {
  memoryHits.clear()
}

/**
 * Checks and consumes one attempt against the rate limit for `key`.
 * Returns `success: false` once `key` has hit MAX_ATTEMPTS within the
 * trailing WINDOW.
 */
export async function checkTotpRateLimit(key: string): Promise<{
  success: boolean
  remaining: number
}> {
  if (hasUpstashConfig()) {
    const { success, remaining } = await getUpstashLimiter().limit(key)
    return { success, remaining }
  }

  warnFallbackIfNeeded()
  return checkInMemory(key)
}
