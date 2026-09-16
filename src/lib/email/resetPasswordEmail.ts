/**
 * Admin password-reset email (FUNCTIONALITY §5.1 "Forgotten Password",
 * TECHSPEC §6.6). Pure body assembly, like quoteEmail.ts / contactEmail.ts.
 *
 * Content follows the OWASP Forgot Password Cheat Sheet: the mail carries ONLY a
 * single-use, expiring reset link to a fixed, configured origin (never a
 * password, never a username hint beyond the address it was sent to), states
 * how long the link is valid, and tells the recipient what to do if they did not
 * ask for it. The admin panel is English-only, so this is not localized.
 *
 * Every interpolated value is HTML-escaped with the PDF template's escaper so the
 * escaping behaves identically across all outbound mail. The URL is escaped too:
 * it is built from `serverURL` + a hex token, so escaping never changes it, but
 * the invariant "no unescaped interpolation in HTML" is worth keeping absolute.
 */

import { escapeHtml } from '@/lib/pdf/template'

export interface ResetPasswordEmailInput {
  /** Absolute HTTPS link to the admin reset screen (serverURL + /admin/reset/<token>). */
  resetUrl: string
  /** How long the link stays valid, in minutes (Payload's `forgotPassword.expiration`). */
  expiresInMinutes: number
  /** Display name used in the greeting/sign-off, e.g. "Bulbau". */
  companyName: string
}

export interface ResetPasswordEmail {
  subject: string
  html: string
  text: string
}

export function resetPasswordSubject(companyName: string): string {
  return `Reset your ${companyName} admin password`
}

export function renderResetPasswordEmail(input: ResetPasswordEmailInput): ResetPasswordEmail {
  const e = escapeHtml
  const minutes = Math.max(1, Math.round(input.expiresInMinutes))
  const validity =
    minutes % 60 === 0
      ? `${minutes / 60} hour${minutes === 60 ? '' : 's'}`
      : `${minutes} minute${minutes === 1 ? '' : 's'}`

  const intro = `Someone asked to reset the password for your ${input.companyName} admin account. If that was you, use the link below to choose a new password.`
  const expiry = `The link is valid for ${validity} and can be used once.`
  const ignore = `If you did not request this, you can ignore this email — your password will not change. Someone else may have typed your address by mistake.`
  const signoff = `— ${input.companyName} website`

  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px;background:#f5f7fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e4e7eb;">
<tr><td style="padding:28px 32px 8px;">
<h1 style="margin:0 0 20px;font-size:20px;font-weight:700;color:#BF4C00;">${e(resetPasswordSubject(input.companyName))}</h1>
<p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#1f2933;">${e(intro)}</p>
<p style="margin:0 0 20px;"><a href="${e(input.resetUrl)}" style="display:inline-block;padding:12px 20px;background:#BF4C00;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;font-size:15px;">Choose a new password</a></p>
<p style="margin:0 0 16px;font-size:13px;line-height:1.55;color:#52606d;">Or copy this link into your browser:<br><a href="${e(input.resetUrl)}" style="color:#0b7285;word-break:break-all;">${e(input.resetUrl)}</a></p>
<p style="margin:0 0 16px;font-size:14px;line-height:1.55;color:#1f2933;">${e(expiry)}</p>
</td></tr>
<tr><td style="padding:16px 32px 28px;border-top:1px solid #e4e7eb;">
<p style="margin:0 0 8px;font-size:14px;line-height:1.55;color:#52606d;">${e(ignore)}</p>
<p style="margin:0;font-size:14px;color:#1f2933;">${e(signoff)}</p>
</td></tr>
</table>
</body>
</html>`

  const text = [
    resetPasswordSubject(input.companyName),
    '',
    intro,
    '',
    input.resetUrl,
    '',
    expiry,
    '',
    ignore,
    '',
    signoff,
  ].join('\n')

  return { subject: resetPasswordSubject(input.companyName), html, text }
}
