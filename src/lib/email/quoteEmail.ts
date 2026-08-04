/**
 * Quote-email body assembly (Phase 4 part 2 — FUNCTIONALITY §4 Delivery/§7).
 *
 * A pure module (no React, no next-intl runtime, no AWS) — like src/lib/pdf/quote.ts.
 * The caller (the /api/quote route) resolves every user-visible string from the
 * next-intl catalog in the visitor's selected language and passes them in, so the
 * whole email is produced in that language (FUNCTIONALITY §4 "Language"). This
 * module only lays those strings into a small, self-contained HTML message and a
 * plain-text alternative (both parts are required for good deliverability and for
 * clients that don't render HTML). All interpolated values are HTML-escaped in the
 * HTML part, reusing the PDF template's escaper so escaping behaves identically.
 *
 * The PDF itself is the attachment (assembled/rendered by src/lib/pdf/*); the body
 * is a short, friendly note reiterating that the quote is an estimate and inviting
 * the visitor to get in touch (FUNCTIONALITY §4 Delivery — Email).
 */

import { escapeHtml } from '@/lib/pdf/template'

/** Company contact block shown in the signature (FUNCTIONALITY §4.6). */
export interface QuoteEmailCompany {
  name: string
  phone: string | null
  email: string | null
}

/**
 * Every localized string the email needs, already resolved + interpolated by the
 * caller (so this module stays pure and language-agnostic).
 */
export interface QuoteEmailContent {
  /** Visible heading, e.g. "Your price estimate". */
  heading: string
  /** Body paragraphs in order (greeting, intro, estimate reminder, invitation). */
  paragraphs: string[]
  /** Optional "Estimated total: €1,234" line; omitted in the §7 contact-us state. */
  totalLine?: string | null
  /** Sign-off line, e.g. "Best regards, {company}". */
  signoff: string
  /** Contact-detail labels for the signature. */
  phoneLabel: string
  emailLabel: string
  company: QuoteEmailCompany
}

/** Assembled message parts ready to hand to the SES client. */
export interface QuoteEmailBody {
  html: string
  text: string
}

/** Contact lines present on the company (label + value), skipping empties. */
function contactPairs(c: QuoteEmailContent): Array<{ label: string; value: string }> {
  const pairs: Array<{ label: string; value: string }> = []
  if (c.company.phone) pairs.push({ label: c.phoneLabel, value: c.company.phone })
  if (c.company.email) pairs.push({ label: c.emailLabel, value: c.company.email })
  return pairs
}

/** Render the HTML part. Self-contained inline styles; every value escaped. */
export function renderQuoteEmailHtml(c: QuoteEmailContent): string {
  const e = escapeHtml
  const paragraphs = c.paragraphs
    .map(
      (p) =>
        `<p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#1f2933;">${e(p)}</p>`,
    )
    .join('')

  const totalBlock = c.totalLine
    ? `<p style="margin:0 0 16px;font-size:16px;font-weight:600;color:#0b7285;">${e(c.totalLine)}</p>`
    : ''

  const contact = contactPairs(c)
    .map(
      (pair) =>
        `<div style="font-size:14px;line-height:1.5;color:#52606d;">${e(pair.label)}: ${e(pair.value)}</div>`,
    )
    .join('')

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px;background:#f5f7fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e4e7eb;">
<tr><td style="padding:28px 32px 8px;">
<h1 style="margin:0 0 20px;font-size:20px;font-weight:700;color:#0b7285;">${e(c.heading)}</h1>
${paragraphs}
${totalBlock}
</td></tr>
<tr><td style="padding:16px 32px 28px;border-top:1px solid #e4e7eb;">
<p style="margin:0 0 8px;font-size:14px;color:#1f2933;">${e(c.signoff)}</p>
${contact}
</td></tr>
</table>
</body>
</html>`
}

/** Render the plain-text alternative (no escaping needed; not HTML). */
export function renderQuoteEmailText(c: QuoteEmailContent): string {
  const lines: string[] = [c.heading, '']
  for (const p of c.paragraphs) {
    lines.push(p, '')
  }
  if (c.totalLine) lines.push(c.totalLine, '')
  lines.push(c.signoff)
  for (const pair of contactPairs(c)) {
    lines.push(`${pair.label}: ${pair.value}`)
  }
  return lines.join('\n')
}

/** Convenience: build both parts at once. */
export function renderQuoteEmail(c: QuoteEmailContent): QuoteEmailBody {
  return { html: renderQuoteEmailHtml(c), text: renderQuoteEmailText(c) }
}
