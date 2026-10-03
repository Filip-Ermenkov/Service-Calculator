import type { Endpoint } from 'payload'

import { logOpsEvent } from '@/lib/observability/opsLog'
import { decryptTotpSecret, encryptTotpSecret } from '@/lib/totp/crypto'
import { buildOtpAuthUri, generateTotpSecret, otpEnvironmentTag, verifyTotpToken } from '@/lib/totp/otp'
import { generateQrCodeDataUrl } from '@/lib/totp/qr'
import { getClientIp } from '@/lib/rateLimit'
import { checkTotpRateLimit } from '@/lib/totp/rateLimit'
import {
  buildStepUpClearCookie,
  buildStepUpSetCookie,
  isStepUpVerified,
} from '@/lib/totp/requestHelpers'

/**
 * Custom TOTP endpoints, mounted under /api/users/totp/* (see the
 * `endpoints` array on the Users collection). These sit alongside Payload's
 * own built-in auth endpoints (/api/users/login, /logout, etc. — untouched)
 * rather than replacing them: password auth (first factor) stays exactly
 * as Payload provides it; these add the second factor on top.
 *
 * Security note repeated at each handler: `req.user` alone only proves the
 * PASSWORD step passed. It is deliberately not sufficient on its own to
 * read/write anything else in the app (see src/access/requireTotpVerified.ts)
 * — these endpoints are the one exception, and each one reasons explicitly
 * about which factor(s) it requires before acting.
 */

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status })
}

export const totpSetupEndpoint: Endpoint = {
  path: '/totp/setup',
  method: 'post',
  handler: async (req) => {
    if (!req.user) return jsonError('Not authenticated', 401)

    // Re-enrolling (replacing an already-active secret, e.g. a new phone)
    // requires proof of the SECOND factor too — otherwise a stolen password
    // alone would let an attacker silently swap in their own secret and
    // lock the real admin out while looking, from the outside, like normal
    // "re-link my device" usage. First-time enrollment has no existing
    // secret to protect, so it only needs the password step.
    if (req.user.totpEnabled && !isStepUpVerified(req.headers, String(req.user.id))) {
      return jsonError('Re-enrolling an existing 2FA device requires verifying the current one first', 403)
    }

    const rateLimit = await checkTotpRateLimit(`totp-setup:${req.user.id}`)
    if (!rateLimit.success) return jsonError('Too many attempts. Please wait and try again.', 429)

    // First-time enrolment REUSES a pending (never confirmed) secret rather than
    // minting a new one per call. The setup view mounts more than once in normal
    // use (land here → gated route → redirected back, a page reload, HMR in dev),
    // and every mount used to replace the secret behind the QR the admin had
    // just scanned — the code their app then produced was for a secret that no
    // longer existed, reported as a plain "Invalid code". Reuse is no weaker: a
    // pending secret is only reachable through the same password login that
    // could mint a fresh one. Re-enrolment (totpEnabled) always starts afresh.
    // (Read the row explicitly like /totp/enable and /totp/verify do: Payload's
    // JWT strategy populates `req.user` via the Local API with overrideAccess on,
    // so the field IS present there today, but that is an implementation detail
    // of payload@3.89 — the one documented, access-independent way to read a
    // hidden field is an explicit overrideAccess read.)
    let secret: string | null = null
    if (!req.user.totpEnabled) {
      const row = await req.payload.findByID({
        collection: 'users',
        id: req.user.id,
        overrideAccess: true,
      })
      if (typeof row.totpSecret === 'string' && row.totpSecret) {
        try {
          secret = decryptTotpSecret(row.totpSecret)
        } catch {
          secret = null // undecryptable (key rotated) — replace it below
        }
      }
    }
    const reused = secret !== null
    if (secret === null) secret = generateTotpSecret()

    const otpAuthUri = buildOtpAuthUri({
      secret,
      accountEmail: String(req.user.email),
      environmentTag: otpEnvironmentTag(),
    })
    const qrCodeDataUrl = await generateQrCodeDataUrl(otpAuthUri)

    if (!reused) {
      await req.payload.update({
        collection: 'users',
        id: req.user.id,
        data: {
          totpSecret: encryptTotpSecret(secret),
          // Only flips to true once /totp/enable confirms a real code. A
          // /totp/setup call that's never confirmed leaves the previous
          // enrollment state untouched from the access-control wrapper's
          // point of view.
        },
        overrideAccess: true,
      })
    }

    return Response.json({ secret, otpAuthUri, qrCodeDataUrl })
  },
}

export const totpEnableEndpoint: Endpoint = {
  path: '/totp/enable',
  method: 'post',
  handler: async (req) => {
    if (!req.user) return jsonError('Not authenticated', 401)

    const rateLimit = await checkTotpRateLimit(`totp-enable:${req.user.id}`)
    if (!rateLimit.success) return jsonError('Too many attempts. Please wait and try again.', 429)

    const body = (await req.json?.()) as { code?: string } | undefined
    const code = body?.code
    if (!code) return jsonError('Missing code', 400)

    const user = await req.payload.findByID({
      collection: 'users',
      id: req.user.id,
      overrideAccess: true,
    })

    if (!user.totpSecret) {
      return jsonError('No pending 2FA setup found — call /totp/setup first', 409)
    }

    const secret = decryptTotpSecret(user.totpSecret as string)
    const result = await verifyTotpToken({ secret, token: code })

    if (!result.valid) return jsonError('Invalid code', 401)

    await req.payload.update({
      collection: 'users',
      id: req.user.id,
      data: {
        totpEnabled: true,
        totpLastTimeStep: result.timeStep,
      },
      overrideAccess: true,
    })

    const response = Response.json({ success: true })
    response.headers.append('Set-Cookie', buildStepUpSetCookie(String(req.user.id)))
    return response
  },
}

export const totpVerifyEndpoint: Endpoint = {
  path: '/totp/verify',
  method: 'post',
  handler: async (req) => {
    if (!req.user) return jsonError('Not authenticated', 401)
    if (!req.user.totpEnabled) return jsonError('2FA is not enabled for this account', 409)

    // Per-user AND per-IP budgets. The IP is resolved with the shared, CloudFront-
    // aware helper (last X-Forwarded-For hop = the address CloudFront itself
    // appended from the TCP connection), NOT the first hop: the first hop is
    // whatever the client chose to send, so keying on it let an attacker rotate
    // the per-IP budget away by changing a header. Verified against production
    // on 2026-09-13 — CloudFront strips viewer-supplied CloudFront-Viewer-Address
    // and X-Real-IP and appends the true viewer IP last. (The per-user budget was
    // never bypassable; this closes the defence-in-depth gap, keeping the two
    // public rate-limited routes and this one on one IP definition.)
    const userKey = `totp-verify:${req.user.id}`
    const ipKey = `totp-verify-ip:${getClientIp(req)}`
    const [userLimit, ipLimit] = await Promise.all([
      checkTotpRateLimit(userKey),
      checkTotpRateLimit(ipKey),
    ])
    if (!userLimit.success || !ipLimit.success) {
      return jsonError('Too many attempts. Please wait and try again.', 429)
    }

    const body = (await req.json?.()) as { code?: string } | undefined
    const code = body?.code
    if (!code) return jsonError('Missing code', 400)

    const user = await req.payload.findByID({
      collection: 'users',
      id: req.user.id,
      overrideAccess: true,
    })

    if (!user.totpSecret) return jsonError('2FA is not configured for this account', 409)

    const secret = decryptTotpSecret(user.totpSecret as string)
    const result = await verifyTotpToken({
      secret,
      token: code,
      afterTimeStep: (user.totpLastTimeStep as number | undefined) ?? undefined,
    })

    if (!result.valid) return jsonError('Invalid code', 401)

    await req.payload.update({
      collection: 'users',
      id: req.user.id,
      data: { totpLastTimeStep: result.timeStep },
      overrideAccess: true,
    })

    const response = Response.json({ success: true })
    response.headers.append('Set-Cookie', buildStepUpSetCookie(String(req.user.id)))
    return response
  },
}

export const totpDisableEndpoint: Endpoint = {
  path: '/totp/disable',
  method: 'post',
  handler: async (req) => {
    if (!req.user) return jsonError('Not authenticated', 401)
    if (!isStepUpVerified(req.headers, String(req.user.id))) {
      return jsonError('Verifying your current 2FA code is required before disabling it', 403)
    }

    const body = (await req.json?.()) as { currentPassword?: string } | undefined
    if (!body?.currentPassword) return jsonError('Missing currentPassword', 400)

    try {
      // Re-confirms the password step for this specific sensitive action,
      // rather than trusting that the session is still "fresh" enough.
      // Deliberately not passing `req` through: Payload's Local API types
      // that option as a plain (non-Payload) Request, which the incoming
      // PayloadRequest doesn't structurally satisfy, and this call doesn't
      // need req-scoped context (locale, req-bound hooks) — it's just a
      // password re-check.
      await req.payload.login({
        collection: 'users',
        data: { email: String(req.user.email), password: body.currentPassword },
      })
    } catch {
      return jsonError('Incorrect password', 401)
    }

    await req.payload.update({
      collection: 'users',
      id: req.user.id,
      data: {
        totpEnabled: false,
        totpSecret: null,
        totpLastTimeStep: null,
      },
      overrideAccess: true,
    })

    const response = Response.json({ success: true })
    response.headers.append('Set-Cookie', buildStepUpClearCookie())
    return response
  },
}

/**
 * ADMIN-ASSISTED 2FA RESET — the break-glass path for "the client lost their phone".
 *
 * ── Why this exists ───────────────────────────────────────────────────────────
 * `/totp/disable` above only ever acts on `req.user.id`, and the `totpSecret` /
 * `totpEnabled` fields are declared `access: { update: () => false }`, so they
 * cannot be cleared through the admin UI or the REST API either. Until this
 * endpoint, an admin who lost their authenticator was locked out PERMANENTLY and
 * the only way back in was hand-written SQL against the production database:
 *
 *   UPDATE users SET totp_secret = NULL, totp_enabled = false,
 *                    totp_last_time_step = NULL WHERE email = '…';
 *
 * That is an unacceptable recovery procedure for a site a non-technical client
 * logs into: it needs a Neon console, the production credentials, and nerve, at
 * exactly the moment someone is panicking. With a second account now in use
 * (office@bulbau.lu, created 2026-09-29) "someone loses their phone" is a when,
 * not an if.
 *
 * ── What it requires, and why each one ────────────────────────────────────────
 *  • A session (`req.user`) — obviously.
 *  • The ACTING admin's own completed step-up. Without it, a stolen password
 *    alone would let an attacker strip the second factor off every other
 *    account; with it, they must already have beaten 2FA once.
 *  • The acting admin's CURRENT PASSWORD, re-checked here rather than trusting
 *    session freshness — the same bar `/totp/disable` sets for the equivalent
 *    action on yourself.
 *  • A rate-limit budget per actor AND per IP, like `/totp/verify`.
 *
 * It deliberately REFUSES to target yourself: `/totp/disable` already covers
 * that, and that path additionally proves you still hold the current device.
 * Two routes to the same outcome with different guarantees is how the weaker
 * one quietly becomes the one everybody uses.
 *
 * ── What it does NOT do, on purpose ───────────────────────────────────────────
 * It does not let the target back in by itself. Clearing `totpEnabled` makes
 * `requireTotpVerified` deny that account EVERYTHING (it returns false on
 * `!totpEnabled` regardless of any step-up cookie the target may still hold), so
 * their next login lands on /admin/totp-verify, which redirects to
 * /admin/totp-setup for a fresh enrolment. The reset re-opens enrolment; it
 * never grants access.
 *
 * ── Why it pages ──────────────────────────────────────────────────────────────
 * Removing someone's second factor is security-significant and rare (expect
 * roughly zero per year). `logOpsEvent` with `error` severity emits OPS_ALERT,
 * which the metric filter in sst.config.ts turns into an email. That is a
 * deliberate stretch of the "user-visible degradation" wording in
 * src/lib/observability/opsLog.ts — the alarm's description was widened in the
 * same commit — because the alternative is that a reset nobody authorised leaves
 * no trace anyone reads. Only ids are logged, never addresses (invariant 4).
 */
export const totpAdminResetEndpoint: Endpoint = {
  path: '/totp/admin-reset',
  method: 'post',
  handler: async (req) => {
    if (!req.user) return jsonError('Not authenticated', 401)
    if (!isStepUpVerified(req.headers, String(req.user.id))) {
      return jsonError("Verifying your own 2FA code is required before resetting someone else's", 403)
    }

    const [actorLimit, ipLimit] = await Promise.all([
      checkTotpRateLimit(`totp-admin-reset:${req.user.id}`),
      checkTotpRateLimit(`totp-admin-reset-ip:${getClientIp(req)}`),
    ])
    if (!actorLimit.success || !ipLimit.success) {
      return jsonError('Too many attempts. Please wait and try again.', 429)
    }

    const body = (await req.json?.()) as { userId?: unknown; currentPassword?: unknown } | undefined
    const targetId = body?.userId
    if (targetId === undefined || targetId === null || targetId === '') {
      return jsonError('Missing userId', 400)
    }
    if (typeof body?.currentPassword !== 'string' || body.currentPassword === '') {
      return jsonError('Missing currentPassword', 400)
    }
    if (String(targetId) === String(req.user.id)) {
      return jsonError(
        'Use /api/users/totp/disable for your own account — it proves you still hold the current device.',
        400,
      )
    }

    try {
      // Same reasoning as /totp/disable: re-confirm the password step for this
      // one sensitive action. `req` is deliberately not passed (Payload types
      // that option as a plain Request) — this is only a password re-check.
      await req.payload.login({
        collection: 'users',
        data: { email: String(req.user.email), password: body.currentPassword },
      })
    } catch {
      return jsonError('Incorrect password', 401)
    }

    // `disableErrors` turns "no such row" into null; the try/catch additionally
    // covers an id the database cannot even coerce (ids are integers here, so a
    // non-numeric string must be a 404, never a 500).
    type TargetRow = { id: string | number; totpEnabled?: unknown; totpSecret?: unknown }
    let target: TargetRow | null = null
    try {
      target = (await req.payload.findByID({
        collection: 'users',
        id: targetId as string,
        overrideAccess: true,
        disableErrors: true,
      })) as TargetRow | null
    } catch {
      target = null
    }
    if (!target) return jsonError('No such user', 404)

    // Idempotent on purpose: the operation is "this account has no second
    // factor", and in a recovery the operator should not have to care whether a
    // half-finished enrolment left a pending secret behind. Reported back so the
    // UI can say which happened.
    const hadTotp = Boolean(target.totpEnabled) || Boolean(target.totpSecret)

    await req.payload.update({
      collection: 'users',
      id: target.id,
      data: { totpEnabled: false, totpSecret: null, totpLastTimeStep: null },
      overrideAccess: true,
    })

    logOpsEvent(
      'security.totpAdminReset',
      `2FA was reset for user ${target.id} by user ${req.user.id}`,
      'error',
      { actorId: String(req.user.id), targetId: String(target.id), hadTotp },
    )

    return Response.json({ success: true, hadTotp })
  },
}

export const totpStatusEndpoint: Endpoint = {
  path: '/totp/status',
  method: 'get',
  handler: async (req) => {
    if (!req.user) return jsonError('Not authenticated', 401)

    return Response.json({
      totpEnabled: Boolean(req.user.totpEnabled),
      stepUpVerified: isStepUpVerified(req.headers, String(req.user.id)),
    })
  },
}
