import type { Endpoint } from 'payload'

import { decryptTotpSecret, encryptTotpSecret } from '@/lib/totp/crypto'
import { buildOtpAuthUri, generateTotpSecret, verifyTotpToken } from '@/lib/totp/otp'
import { generateQrCodeDataUrl } from '@/lib/totp/qr'
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

function clientIp(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0]!.trim()
  return 'unknown'
}

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

    const secret = generateTotpSecret()
    const otpAuthUri = buildOtpAuthUri({ secret, accountEmail: String(req.user.email) })
    const qrCodeDataUrl = await generateQrCodeDataUrl(otpAuthUri)

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

    const userKey = `totp-verify:${req.user.id}`
    const ipKey = `totp-verify-ip:${clientIp(req.headers)}`
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
