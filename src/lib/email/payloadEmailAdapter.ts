/**
 * Payload email adapter over Amazon SES v2 (FUNCTIONALITY §5.1 "Forgotten
 * Password", TECHSPEC §6.6 "password reset … emailed via SES").
 *
 * ── The gap this closes (found 2026-09-16) ────────────────────────────────────
 * `payload.config.ts` configured no `email` adapter. Payload then falls back to
 * its console adapter, which — verified in the installed payload@3.89 source —
 * only logs `Email attempted without being configured. To: …, Subject: …` and
 * resolves. So the admin "Forgot your password?" screen reported success while
 * nothing was ever sent: with a single administrator and mandatory 2FA, that made
 * a forgotten password unrecoverable without direct database access. Payload's
 * own docs call the console fallback "not production-safe".
 *
 * ── Why a ~60-line custom adapter, not @payloadcms/email-nodemailer ───────────
 * Payload ships two official adapters: Nodemailer (SMTP — would need SES SMTP
 * credentials, i.e. a NEW long-lived secret to store and rotate) and Resend (a new
 * third-party sub-processor). This app already sends transactional mail through
 * SES v2 with the Lambda execution role (`src/lib/email/ses.ts`: no secret, no new
 * vendor, verified `bulbau.lu` identity with DKIM/SPF/DMARC). Payload's adapter
 * interface is four fields (`name`, `defaultFromAddress`, `defaultFromName`,
 * `sendEmail`), so the right tool is a thin bridge onto that existing path —
 * zero new dependencies, one credential model, the same never-throws contract.
 *
 * ── Behaviour ─────────────────────────────────────────────────────────────────
 *   • Configured (`EMAIL_SENDER` set): sends via `sendEmail()`. Payload passes
 *     `from` as `"Name" <address>`; the address is always our verified sender, the
 *     name is `fromName`. A plain-text alternative is derived from Payload's HTML
 *     (Payload only supplies `html`), because multipart text+HTML is the
 *     deliverability baseline every other mail from this app already meets.
 *   • Not configured, non-production (dev / CI / vitest): logs the message
 *     INCLUDING its body to the server console, so a developer can complete the
 *     reset flow locally by copying the link — the same convenience Payload's
 *     console adapter offers, minus the false "sent" impression.
 *   • Not configured, production: logs an `OPS_ALERT` (`email.payload.notConfigured`)
 *     and nothing else. An admin recovery mail that silently went nowhere is an
 *     operator-visible incident, not a debug line — and the body (a live reset
 *     link) must never land in CloudWatch.
 *   • Never throws (`sendEmail()` never does). Payload's forgot-password
 *     operation therefore always completes with its uniform "success" response,
 *     which is also what the OWASP cheat sheet asks for (no account enumeration
 *     through error differences); a real SES failure is paged via `OPS_ALERT`
 *     inside `sendEmail()`.
 */

import type { EmailAdapter } from 'payload'

import { logOpsEvent } from '../observability/opsLog'
import { getEmailSender, sendEmail, type EmailAttachment, type SendResult } from './ses'

/** The subset of nodemailer's `SendMailOptions` Payload actually passes. */
interface AddressLike {
  name?: string
  address?: string
}
type Recipient = string | AddressLike
export interface IncomingMessage {
  to?: Recipient | Recipient[]
  from?: Recipient | Recipient[]
  replyTo?: Recipient | Recipient[]
  subject?: string
  html?: string | Buffer
  text?: string | Buffer
  attachments?: Array<{
    filename?: string | false
    content?: string | Buffer
    contentType?: string
  }>
}

/** Bare addresses from a nodemailer-style recipient value (strings or `{ address }`). */
export function toAddressList(value: IncomingMessage['to']): string[] {
  const list = Array.isArray(value) ? value : value ? [value] : []
  return list
    .map((v) => (typeof v === 'string' ? v : v?.address ?? ''))
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * A readable plain-text rendering of an HTML email — links become `text (url)`,
 * block boundaries become line breaks, tags are dropped, the handful of entities
 * the templates emit are decoded. Deliberately small; it only has to serve mail
 * this app generates, not arbitrary HTML.
 *
 * Implemented as a one-pass tokenizer rather than a chain of regex `replace`
 * calls (the 2026-09-18 rewrite). The previous chain was flagged by CodeQL —
 * `js/incomplete-multi-character-sanitization` (a `<style…</style>` regex is not
 * a sanitizer: `<sty<style>le>` survives one pass) and `js/double-escaping`
 * (decoding `&amp;` before `&lt;` turns `&amp;lt;` into `<`). Neither was
 * reachable with our own templates, but a single left-to-right walk that skips
 * `<head>`/`<style>`/`<script>` containers structurally and decodes entities
 * exactly once, in one alternation, has no such edge at all — and is no longer
 * a pattern a scanner has to reason about.
 */
export function plainTextFromHtml(html: string): string {
  /** Containers whose entire content is dropped, not just their tags. */
  const DROP_CONTAINERS = new Set(['head', 'style', 'script', 'title'])
  /** Closing tags that end a block → a line break in the text rendering. */
  const BLOCK_CLOSERS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr', 'table'])

  let out = ''
  let i = 0
  // Link state: while inside <a href="…">, buffer the label so it can be
  // rendered as `label (href)` (or just the href when the label IS the href).
  let linkHref: string | null = null
  let linkLabel = ''

  const emit = (text: string) => {
    if (linkHref !== null) linkLabel += text
    else out += text
  }

  while (i < html.length) {
    const lt = html.indexOf('<', i)
    if (lt === -1) {
      emit(html.slice(i))
      break
    }
    emit(html.slice(i, lt))
    const gt = html.indexOf('>', lt + 1)
    if (gt === -1) {
      // An unterminated `<`: nothing after it can be a tag; drop the remainder.
      break
    }
    const raw = html.slice(lt + 1, gt).trim()
    i = gt + 1

    const isClosing = raw.startsWith('/')
    const name = (isClosing ? raw.slice(1) : raw).split(/[\s/]/, 1)[0].toLowerCase()

    if (!isClosing && DROP_CONTAINERS.has(name)) {
      // Skip everything up to and including the matching close tag (case-
      // insensitive), or to the end if it never closes.
      const closeAt = html.toLowerCase().indexOf(`</${name}`, i)
      if (closeAt === -1) break
      const closeEnd = html.indexOf('>', closeAt)
      i = closeEnd === -1 ? html.length : closeEnd + 1
      continue
    }

    if (name === 'a') {
      if (!isClosing) {
        const href =
          /\bhref\s*=\s*"([^"]*)"/i.exec(raw)?.[1] ?? /\bhref\s*=\s*'([^']*)'/i.exec(raw)?.[1] ?? ''
        linkHref = href
        linkLabel = ''
      } else if (linkHref !== null) {
        const label = linkLabel.trim()
        out += label && label !== linkHref ? `${label} (${linkHref})` : linkHref || label
        linkHref = null
        linkLabel = ''
      }
      continue
    }

    if (name === 'br') {
      emit('\n')
      continue
    }
    if (isClosing && BLOCK_CLOSERS.has(name)) {
      emit('\n')
      continue
    }
    // Any other tag (opening or closing) contributes nothing to the text.
  }
  // A link that never closed: keep its text rather than losing it.
  if (linkHref !== null) out += linkLabel.trim() || linkHref

  const ENTITY: Record<string, string> = {
    '&nbsp;': ' ',
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
  }
  return (
    out
      // One pass, one alternation: every entity is decoded exactly once, so a
      // literal `&amp;lt;` in the source correctly becomes `&lt;` in the text.
      .replace(/&(?:nbsp|amp|lt|gt|quot|#39);/g, (m) => ENTITY[m] ?? m)
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
}

/** Payload's attachment shape → the SES helper's (only the first is forwarded — Payload sends none today). */
function firstAttachment(message: IncomingMessage): EmailAttachment | undefined {
  const a = message.attachments?.[0]
  if (!a || !a.content) return undefined
  return {
    filename: typeof a.filename === 'string' && a.filename ? a.filename : 'attachment',
    content: Buffer.isBuffer(a.content) ? a.content : Buffer.from(String(a.content)),
    contentType: a.contentType,
  }
}

export interface PayloadEmailAdapterOptions {
  /** Display name for the From header, e.g. "Bulbau". */
  fromName: string
}

/**
 * Outcome the adapter resolves with. Payload ignores the value; it is returned
 * for tests and for callers that use `payload.sendEmail()` directly.
 */
export type PayloadEmailSendOutcome = SendResult | { ok: false; reason: 'no_recipient' }

/**
 * Build the Payload email adapter. `defaultFromAddress` is the verified
 * `EMAIL_SENDER` when set; when unset it falls back to a clearly-invalid
 * placeholder so a not-configured stage can never accidentally spoof a real
 * address in a log line.
 */
export function payloadEmailAdapter(
  options: PayloadEmailAdapterOptions,
): EmailAdapter<PayloadEmailSendOutcome> {
  return () => ({
    name: 'bulbau-ses-v2',
    defaultFromName: options.fromName,
    defaultFromAddress: getEmailSender() ?? 'not-configured@localhost',
    sendEmail: async (raw): Promise<PayloadEmailSendOutcome> => {
      const message = raw as IncomingMessage
      const to = toAddressList(message.to)
      const subject = message.subject ?? ''
      const html =
        typeof message.html === 'string'
          ? message.html
          : message.html
            ? message.html.toString('utf8')
            : ''
      const text =
        typeof message.text === 'string'
          ? message.text
          : message.text
            ? message.text.toString('utf8')
            : plainTextFromHtml(html)

      if (to.length === 0) {
        logOpsEvent('email.payload.noRecipient', `"${subject}" had no recipient`, 'warn')
        return { ok: false, reason: 'no_recipient' }
      }

      const sender = getEmailSender()
      if (!sender) {
        if (process.env.NODE_ENV === 'production') {
          // A stage with no verified sender cannot deliver the admin's recovery
          // mail. That is an operator problem (set the EmailSender secret), so it
          // pages — and the body, which holds a live reset link, stays out of logs.
          logOpsEvent(
            'email.payload.notConfigured',
            `EMAIL_SENDER unset — "${subject}" was NOT sent (set the EmailSender secret)`,
            'error',
          )
        } else {
          // Local dev / CI: make the flow completable by hand. This is the one
          // place the body is logged, and only ever outside production.
          console.info(
            `[email] EMAIL_SENDER is not set — not sending. Would have sent to ${to.join(', ')}:\n` +
              `Subject: ${subject}\n${text}`,
          )
        }
        return { ok: false, reason: 'not_configured' }
      }

      // Payload formats `from` as `"<defaultFromName>" <defaultFromAddress>`; we
      // pass it through when it names OUR verified address and rebuild it
      // otherwise, so the address part can never drift from the SES identity.
      const requestedFrom = toAddressList(message.from)[0]
      const from =
        requestedFrom && requestedFrom.includes(`<${sender}>`)
          ? requestedFrom
          : `"${options.fromName.replace(/"/g, '')}" <${sender}>`
      const replyTo = toAddressList(message.replyTo)[0] ?? null

      return sendEmail({
        to,
        from,
        replyTo,
        subject,
        html,
        text,
        attachment: firstAttachment(message),
      })
    },
  })
}
