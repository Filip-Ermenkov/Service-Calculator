import { checkRateLimit, __resetRateLimitForTests, type RateLimitPolicy } from '@/lib/rateLimit'

/**
 * Rate limiting / lockout for the TOTP verification and enrollment steps
 * (distinct from Payload's own built-in password-attempt lockout — see
 * `auth.maxLoginAttempts`/`auth.lockTime` on the Users collection — this
 * covers brute-forcing a 6-digit code once past the password step).
 *
 * The limiter itself (Upstash-or-in-memory sliding window) now lives in the
 * shared `@/lib/rateLimit` module so the public `/api/quote` endpoint can reuse
 * the exact same proven implementation with its own policy. This file keeps the
 * TOTP-specific policy (5 attempts / 5 minutes, prefix `bulbau-totp`) and the
 * long-standing public API (`checkTotpRateLimit`, `__resetInMemoryRateLimitForTests`)
 * so nothing that already depends on it changes.
 */

const TOTP_POLICY: RateLimitPolicy = {
  prefix: 'bulbau-totp',
  max: 5,
  windowSeconds: 5 * 60,
}

/** Resets in-memory counters. Test-only helper (kept name-stable for existing tests). */
export function __resetInMemoryRateLimitForTests(): void {
  __resetRateLimitForTests()
}

/**
 * Checks and consumes one attempt against the TOTP rate limit for `key`.
 * Returns `success: false` once `key` has hit 5 attempts within 5 minutes.
 */
export async function checkTotpRateLimit(key: string): Promise<{
  success: boolean
  remaining: number
}> {
  return checkRateLimit(TOTP_POLICY, key)
}
