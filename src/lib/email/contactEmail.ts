/**
 * Contact-form email body assembly (Phase 6 — FUNCTIONALITY §6, TECHSPEC §6.8).
 *
 * A pure module (no React, no next-intl runtime, no AWS) — like quoteEmail.ts.
 * The /api/contact route validates the visitor's submission and passes the raw
 * fields in; this module lays them into an HTML message + a plain-text
 * alternative that is relayed to the company's own inbox (CompanyInfo.email).
 * The message is NOT persisted anywhere (GDPR data-minimisation, TECHSPEC §7A) —
 * it is delivered straight to the inbox and forgotten.
 *
 * Every interpolated value is HTML-escaped in the HTML part (reusing the PDF
 * template's escaper so escaping behaves identically), because the fields are
 * fully attacker-controlled free text. The submitter's address is set as the
 * email's Reply-To by the route, so the owner can reply to the visitor directly
 * from their mail client.
 */

import { escapeHtml } from '@/lib/pdf/template'

/** A validated contact submission (already trimmed + length-checked by the route). */
export interface ContactSubmission {
  name: string
  email: string
  /** Optional subject; falls back to a generic heading when absent. */
  subject?: string | null
  message: string
}

/** Localized labels for the relayed email (resolved by the route from next-intl). */
export interface ContactEmailLabels {
  /** e.g. "New message from the website contact form". */
  heading: string
  nameLabel: string
  emailLabel: string
  subjectLabel: string
  messageLabel: string
  /** e.g. "Sent via the bulbau.lu contact form." */
  footerNote: string
}

/** Assembled message parts + the derived subject line, ready for the SES client. */
export interface ContactEmailBody {
  subject: string
  html: string
  text: string
}

/** Convert a message's newlines into <br> after escaping (preserve line breaks). */
function messageToHtml(message: string): string {
  return escapeHtml(message).replace(/\r?\n/g, '<br>')
}

/**
 * Build the relay email. `subjectPrefix` is a localized prefix like
 * "Contact form:"; the final subject is `"<prefix> <subject-or-name>"`.
 */
export function renderContactEmail(
  submission: ContactSubmission,
  labels: ContactEmailLabels,
  subjectPrefix: string,
): ContactEmailBody {
  const e = escapeHtml
  const subjectText = submission.subject?.trim() || submission.name
  const subject = `${subjectPrefix} ${subjectText}`.trim()

  const rows: Array<{ label: string; value: string; isMessage?: boolean }> = [
    { label: labels.nameLabel, value: submission.name },
    { label: labels.emailLabel, value: submission.email },
  ]
  if (submission.subject?.trim()) {
    rows.push({ label: labels.subjectLabel, value: submission.subject.trim() })
  }
  rows.push({ label: labels.messageLabel, value: submission.message, isMessage: true })

  const rowsHtml = rows
    .map(
      (r) => `<tr>
<td style="padding:8px 12px;font-size:13px;font-weight:600;color:#52606d;vertical-align:top;white-space:nowrap;">${e(r.label)}</td>
<td style="padding:8px 12px;font-size:14px;color:#1f2933;line-height:1.55;">${r.isMessage ? messageToHtml(r.value) : e(r.value)}</td>
</tr>`,
    )
    .join('')

  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px;background:#f5f7fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e4e7eb;">
<tr><td style="padding:24px 28px 8px;">
<h1 style="margin:0 0 16px;font-size:18px;font-weight:700;color:#0b7285;">${e(labels.heading)}</h1>
</td></tr>
<tr><td style="padding:0 16px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rowsHtml}</table>
</td></tr>
<tr><td style="padding:12px 28px 24px;border-top:1px solid #e4e7eb;">
<p style="margin:0;font-size:12px;color:#7b8794;">${e(labels.footerNote)}</p>
</td></tr>
</table>
</body>
</html>`

  const textLines: string[] = [labels.heading, '']
  textLines.push(`${labels.nameLabel}: ${submission.name}`)
  textLines.push(`${labels.emailLabel}: ${submission.email}`)
  if (submission.subject?.trim()) {
    textLines.push(`${labels.subjectLabel}: ${submission.subject.trim()}`)
  }
  textLines.push('', `${labels.messageLabel}:`, submission.message, '', labels.footerNote)

  return { subject, html, text: textLines.join('\n') }
}
