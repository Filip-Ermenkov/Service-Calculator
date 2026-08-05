/**
 * Cloudflare Turnstile server-side verification (Phase 6 — FUNCTIONALITY §6,
 * TECHSPEC §3 "Spam protection"/§6.8). Turnstile is a free, privacy-friendly
 * CAPTCHA alternative usable standalone (no need to move DNS/CDN to Cloudflare).
 *
 * WHY THIS MODULE EXISTS
 * The client-side widget alone protects nothing: an attacker can POST any string
 * to the form endpoint without ever solving a challenge (Cloudflare's docs are
 * explicit — "Mandatory server-side validation"). So every protected route calls
 * `verifyTurnstile()` here, which hands the client-supplied token to Cloudflare's
 * Siteverify API and only proceeds on `success: true`. The secret key is read
 * from the environment and NEVER leaves the server (exposing it would let an
 * attacker bypass the check entirely).
 *
 * ENV-GATING (mirrors src/lib/email/ses.ts, src/lib/cdn/invalidate.ts,
 * src/lib/translation/provider.ts)
 * When `TURNSTILE_SECRET_KEY` is unset — local dev, CI, tests, or any stage
 * without Turnstile provisioned — verification is SKIPPED (returns
 * `{ ok: true, skipped: true }`). This is the project's established "unset ⇒
 * no-op" pattern: it keeps local/CI runnable with no Cloudflare account, and the
 * matching client widget (gated on the public `NEXT_PUBLIC_TURNSTILE_SITE_KEY`)
 * simply doesn't render, so there is no token to produce. On a deployed stage
 * with both keys set, the check is enforced. Staging with the real keys is the
 * authority for the Turnstile piece (same posture as the PDF-Lambda render).
 *
 * SAFETY
 * NEVER throws: a network failure/timeout returns `{ ok: false, reason: 'error' }`
 * so the caller can surface a friendly "please try again" rather than a 500. The
 * Siteverify call is time-boxed by an AbortController.
 *
 * Endpoint/params/response shape verified against the Cloudflare Turnstile
 * "Validate the token" docs at implementation time (2026-08).
 */

/** Cloudflare's token-verification endpoint. */
const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

/** Hard ceiling on the Siteverify call so it can never hang a request. */
const VERIFY_TIMEOUT_MS = 5_000

/** Cloudflare caps tokens at 2048 chars — reject anything longer up front. */
const MAX_TOKEN_LENGTH = 2048

/**
 * Outcome of a verification. `skipped` distinguishes the not-configured no-op
 * (an expected state locally/CI) from a genuine pass, for logging/testing;
 * callers should treat any `ok: true` as "allowed". `failed` = Cloudflare
 * rejected the token (forged/expired/duplicate); `error` = the Siteverify call
 * itself failed (network/timeout) and the caller should ask the user to retry.
 */
export type TurnstileResult =
  | { ok: true; skipped?: boolean }
  | { ok: false; reason: 'failed' | 'error'; codes?: string[] }

/** The subset of the Siteverify JSON response this app reads. */
interface SiteverifyResponse {
  success: boolean
  'error-codes'?: string[]
  hostname?: string
  action?: string
}

/** Secret key for this stage, or null when Turnstile is not configured. */
export function getTurnstileSecret(): string | null {
  const value = process.env.TURNSTILE_SECRET_KEY?.trim()
  return value ? value : null
}

/** True when a Turnstile secret is wired for this stage (verification enforced). */
export function isTurnstileConfigured(): boolean {
  return getTurnstileSecret() !== null
}

/**
 * Test seam (mirrors __set…ForTests in ses.ts / cdn/invalidate.ts): when set,
 * replaces the real Siteverify fetch so the module can be exercised with no
 * network. Receives the resolved secret + token + remoteip, returns the parsed
 * Siteverify response.
 */
type VerifyImpl = (
  secret: string,
  token: string,
  remoteip: string | null,
) => Promise<SiteverifyResponse>
let verifyForTests: VerifyImpl | null = null
export function __setTurnstileVerifyForTests(impl: VerifyImpl | null): void {
  verifyForTests = impl
}

/**
 * Verify a Turnstile token against Cloudflare's Siteverify API. NEVER throws.
 * A no-op returning `{ ok: true, skipped: true }` when `TURNSTILE_SECRET_KEY`
 * is unset (so local dev / CI need no Cloudflare account). See the module header
 * for the full contract.
 *
 * @param token    the `cf-turnstile-response` value from the client widget
 * @param remoteip best-effort client IP (optional; Cloudflare cross-checks it)
 */
export async function verifyTurnstile(
  token: unknown,
  remoteip?: string | null,
): Promise<TurnstileResult> {
  const secret = getTurnstileSecret()
  if (!secret) return { ok: true, skipped: true }

  // With Turnstile configured, a missing/oversized token is an immediate fail —
  // there is nothing to verify, so don't spend a network round-trip on it.
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, reason: 'failed', codes: ['missing-input-response'] }
  }

  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new Error('Turnstile verify timed out')),
    VERIFY_TIMEOUT_MS,
  )
  try {
    let data: SiteverifyResponse
    if (verifyForTests) {
      data = await verifyForTests(secret, token, remoteip ?? null)
    } else {
      // Cloudflare accepts application/x-www-form-urlencoded; use it (no JSON
      // Content-Type negotiation) and always parse the JSON response back.
      const form = new URLSearchParams()
      form.set('secret', secret)
      form.set('response', token)
      if (remoteip) form.set('remoteip', remoteip)

      const res = await fetch(SITEVERIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: controller.signal,
      })
      data = (await res.json()) as SiteverifyResponse
    }

    if (data.success) return { ok: true }
    return { ok: false, reason: 'failed', codes: data['error-codes'] }
  } catch (err) {
    console.warn('[turnstile] verification call failed:', (err as Error)?.message ?? err)
    return { ok: false, reason: 'error' }
  } finally {
    clearTimeout(timer)
  }
}
