/**
 * Contact-form relay (Phase 6 — FUNCTIONALITY §6, TECHSPEC §6.8/§7A).
 *
 * POST /api/contact  { name, email, subject?, message, turnstileToken, company }
 *
 * The visitor's message is validated, spam-checked (honeypot + Cloudflare
 * Turnstile), rate-limited by IP, and relayed straight to the company's own
 * inbox (CompanyInfo.email) via SES. It is NEVER persisted (GDPR data
 * minimisation — TECHSPEC §7A): delivered and forgotten. The submitter's address
 * becomes the email's Reply-To, so the owner replies directly from their inbox.
 *
 * This route lives outside the `[locale]` segment (locale travels in the body),
 * so next-intl's middleware never rewrites it; `/api/*` is excluded from the
 * admin proxy.
 *
 * DEFENCE LAYERS, cheapest first (each rejects before the next runs):
 *   1. Content-Length cap  — refuse an oversized body before reading it.
 *   2. IP rate limit       — 5 / min / IP via the shared limiter (before any work).
 *   3. Honeypot            — a hidden field bots fill; if present, silently 200.
 *   4. Field validation    — required/typed/length-bounded.
 *   5. Turnstile           — server-side token verification (no-op when unconfigured).
 *   6. SES send            — never-throwing; failure maps to a friendly error.
 */

import { NextResponse } from 'next/server'
import { getTranslations } from 'next-intl/server'

import { routing, type Locale } from '@/i18n/routing'
import { getCompanyInfo } from '@/lib/content'
import { renderContactEmail, type ContactSubmission } from '@/lib/email/contactEmail'
import { isValidEmail, sendEmail } from '@/lib/email/ses'
import { checkRateLimit, getClientIp, type RateLimitPolicy } from '@/lib/rateLimit'
import { verifyTurnstile } from '@/lib/security/turnstile'

interface ContactRequestBody {
  name?: unknown
  email?: unknown
  subject?: unknown
  message?: unknown
  locale?: unknown
  turnstileToken?: unknown
  /** Honeypot: a hidden field a human never sees. Bots auto-fill it. */
  company?: unknown
}

/**
 * The contact form is unauthenticated and triggers an outbound SES send, so it
 * is throttled to keep it from being used as a mail relay / to run up cost
 * (Well-Architected Security + Cost). 5 / min / IP is ample for a real person
 * sending a message while stopping a scripted loop. Keyed by the same
 * CloudFront-aware, spoof-resistant client IP as /api/quote.
 */
const CONTACT_RATE_LIMIT: RateLimitPolicy = {
  prefix: 'bulbau-contact',
  max: 5,
  windowSeconds: 60,
}

/** Body/field bounds — a contact message is small free text; anything huge is abuse. */
const MAX_BODY_BYTES = 32 * 1024 // 32 KB
const MAX_NAME = 120
const MAX_SUBJECT = 160
const MAX_MESSAGE = 5000

function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (routing.locales as readonly string[]).includes(value)
}

/** A trimmed string within [1, max]; else null. */
function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > max) return null
  return trimmed
}

export async function POST(request: Request) {
  // 1) Reject oversized payloads before reading the body.
  const contentLength = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'payload_too_large' }, { status: 413 })
  }

  // 2) Rate-limit by client IP BEFORE any parsing/DB/SES work.
  const ip = getClientIp(request)
  const rate = await checkRateLimit(CONTACT_RATE_LIMIT, ip)
  if (!rate.success) {
    return NextResponse.json(
      { error: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': String(CONTACT_RATE_LIMIT.windowSeconds) } },
    )
  }

  let body: ContactRequestBody
  try {
    body = (await request.json()) as ContactRequestBody
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  // 3) Honeypot. A real user never sees or fills `company`; a non-empty value is
  //    a bot. Respond 200 as if accepted (don't reveal the trap) but send nothing.
  if (typeof body.company === 'string' && body.company.trim().length > 0) {
    return NextResponse.json({ ok: true }, { status: 200, headers: { 'Cache-Control': 'no-store' } })
  }

  const locale = isLocale(body.locale) ? body.locale : routing.defaultLocale

  // 4) Validate the fields. Collect which ones are bad so the client can mark them.
  const name = boundedString(body.name, MAX_NAME)
  const email = typeof body.email === 'string' ? body.email.trim() : ''
  const subject = boundedString(body.subject, MAX_SUBJECT) // optional
  const message = boundedString(body.message, MAX_MESSAGE)
  const emailOk = isValidEmail(email)

  const invalidFields: string[] = []
  if (!name) invalidFields.push('name')
  if (!emailOk) invalidFields.push('email')
  if (!message) invalidFields.push('message')
  if (invalidFields.length > 0) {
    return NextResponse.json({ error: 'validation_error', fields: invalidFields }, { status: 400 })
  }

  // 5) Turnstile. No-op (passes) when unconfigured (local/CI); enforced when the
  //    secret is set. `error` (Cloudflare unreachable) is surfaced distinctly so
  //    the UI can say "try again" rather than "you failed the check".
  const turnstile = await verifyTurnstile(body.turnstileToken, ip)
  if (!turnstile.ok) {
    return NextResponse.json(
      { error: turnstile.reason === 'error' ? 'turnstile_unavailable' : 'turnstile_failed' },
      { status: turnstile.reason === 'error' ? 502 : 400 },
    )
  }

  // 6) Relay to the company inbox.
  const company = await getCompanyInfo(locale)
  const destination = company?.email ?? null
  if (!destination) {
    // No configured destination address — nothing we can do with the message.
    return NextResponse.json({ error: 'contact_unavailable' }, { status: 503 })
  }

  const t = await getTranslations({ locale, namespace: 'Contact' })
  const submission: ContactSubmission = {
    name: name as string,
    email,
    subject,
    message: message as string,
  }
  const { subject: emailSubject, html, text } = renderContactEmail(
    submission,
    {
      heading: t('emailHeading'),
      nameLabel: t('nameLabel'),
      emailLabel: t('emailLabel'),
      subjectLabel: t('subjectLabel'),
      messageLabel: t('messageLabel'),
      footerNote: t('emailFooter'),
    },
    t('emailSubjectPrefix'),
  )

  const result = await sendEmail({
    to: destination,
    subject: emailSubject,
    html,
    text,
    // Reply-To = the visitor, so the owner replies straight to them. From stays
    // the verified EMAIL_SENDER identity (SPF/DKIM aligned).
    replyTo: email,
  })

  if (result.ok) {
    return NextResponse.json({ ok: true }, { status: 200, headers: { 'Cache-Control': 'no-store' } })
  }
  // not_configured (no verified sender on this stage) and send_failed both map to
  // 502 so the UI shows a "try again / reach us directly" message. Distinguished
  // only in logs, never to the visitor.
  return NextResponse.json({ error: `send_${result.reason}` }, { status: 502 })
}
