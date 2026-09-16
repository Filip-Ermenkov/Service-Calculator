import { generate, generateSecret, generateURI, verify } from 'otplib'

// otplib v13 defaults (SHA-1, 6 digits, 30s period) match what every
// mainstream authenticator app (Google Authenticator, Authy, Microsoft
// Authenticator, 1Password, etc.) expects — see
// https://otplib.yeojz.dev/guide/getting-started, "Configuration Defaults".
// Deviating from these would require the admin's authenticator app to
// support non-default parameters, which is not worth the friction for a
// single-admin site.

const ISSUER = 'bulbau.lu'

/** Generates a fresh, random base32 TOTP secret (20 bytes / 160 bits). */
export function generateTotpSecret(): string {
  return generateSecret()
}

/**
 * Builds the `otpauth://` URI an authenticator app scans (via QR code) or
 * accepts as manual entry text.
 *
 * `environmentTag` (e.g. "localhost:3000", "staging") is appended to the
 * account label on non-production servers, so the same admin enrolling on
 * local, staging and production ends up with three DISTINGUISHABLE entries in
 * their authenticator app instead of three identical "bulbau.lu:
 * name@example.com" rows — reading a code off the wrong one is reported as a
 * plain "Invalid code" and is near-impossible to diagnose from the outside.
 * Production stays exactly `bulbau.lu: <email>`.
 */
export function buildOtpAuthUri(params: {
  secret: string
  accountEmail: string
  environmentTag?: string | null
}): string {
  const label = params.environmentTag
    ? `${params.accountEmail} (${params.environmentTag})`
    : params.accountEmail
  return generateURI({
    issuer: ISSUER,
    label,
    secret: params.secret,
  })
}

const PRODUCTION_HOSTS = new Set(['bulbau.lu', 'www.bulbau.lu'])

/**
 * The tag `buildOtpAuthUri` should carry for THIS server: null on the production
 * domain, otherwise the site host (local dev, the staging CloudFront URL, …).
 * Reads NEXT_PUBLIC_SITE_URL (the deployed stage's origin, an SST secret); with
 * nothing set outside production it assumes a local dev server.
 */
export function otpEnvironmentTag(
  env: { NEXT_PUBLIC_SITE_URL?: string; NODE_ENV?: string } = process.env,
): string | null {
  const raw = env.NEXT_PUBLIC_SITE_URL?.trim()
  if (raw) {
    try {
      const host = new URL(raw).host.toLowerCase()
      return PRODUCTION_HOSTS.has(host) ? null : host
    } catch {
      return raw
    }
  }
  return env.NODE_ENV === 'production' ? null : 'localhost'
}

/** Generates the current 6-digit TOTP token for a secret. Test/dev use only. */
export function generateTotpToken(secret: string): Promise<string> {
  return generate({ secret })
}

export type TotpVerifyResult =
  | { valid: true; timeStep: number }
  | { valid: false; timeStep?: undefined }

/**
 * Verifies a submitted code against the stored secret.
 *
 * - `epochTolerance: 30` accepts the current period plus one adjacent
 *   period each side (±30s) to absorb normal clock drift between the
 *   admin's phone and the server — otplib's own docs list this as the
 *   "Standard 2FA" recommendation (vs. 0 for "Maximum security" or 60 for
 *   "Lenient/mobile").
 * - `afterTimeStep` implements replay protection (otplib's documented
 *   pattern): pass the caller's last-accepted `timeStep` and a code from an
 *   already-used period is rejected even if still inside the tolerance
 *   window. Callers are responsible for persisting the returned `timeStep`
 *   after a valid result and threading it back in on the next call.
 */
export async function verifyTotpToken(params: {
  secret: string
  token: string
  afterTimeStep?: number
}): Promise<TotpVerifyResult> {
  try {
    const result = await verify({
      secret: params.secret,
      token: params.token,
      epochTolerance: 30,
      ...(params.afterTimeStep !== undefined && { afterTimeStep: params.afterTimeStep }),
    })

    // otplib's generic `verify()` (which also supports HOTP via a `strategy`
    // option we never pass) types its return as a union of the TOTP and HOTP
    // result shapes, and only the TOTP one carries `timeStep` — TS can't
    // narrow that from `result.valid` alone since both share that field. At
    // runtime this call is always TOTP (no `strategy` passed, and TOTP is
    // the library default), so `timeStep` is always actually present on a
    // valid result; the `in` check satisfies the type checker without
    // pulling in @otplib/totp directly just for a narrower type.
    if (result.valid && 'timeStep' in result) {
      return { valid: true, timeStep: result.timeStep }
    }

    return { valid: false }
  } catch {
    // Malformed input (non-numeric, wrong length, etc. — otplib throws
    // TokenFormatError/TokenLengthError for these) is just an invalid code
    // from the caller's perspective, not a server error.
    return { valid: false }
  }
}
