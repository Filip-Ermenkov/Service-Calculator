/**
 * Transactional email via Amazon SES v2 (Phase 4 part 2 — FUNCTIONALITY §4/§7,
 * TECHSPEC §6.5). The only sending path in the app today is the "email me the
 * quote" action: the PDF is rendered by the isolated Chromium Lambda exactly as
 * for the download path (src/lib/pdf/*), then this module attaches it and sends.
 *
 * WHY THE WEB FUNCTION SENDS (deliberate deviation from TECHSPEC §6.5's sketch)
 * §6.5 imagined the PDF Lambda itself calling SES. But after Phase 4 part 1 the
 * PDF function is a pure, DB-less RENDERER that returns bytes, and the Web
 * function already does auth, authoritative re-pricing, rate-limiting and the
 * next-intl body copy. Sending from the Web function (which already holds the PDF
 * bytes) keeps the renderer stateless and puts the recipient address + localized
 * body next to the code that produces them. The runtime `ses:SendEmail`
 * permission is granted to the Web function in sst.config.ts.
 *
 * WHY SES v2 SIMPLE CONTENT + native Attachments (not hand-built MIME / nodemailer)
 * Since 2025-04 the SES v2 `SendEmail` API accepts attachments directly on Simple
 * content (an `Attachments[]` array of `{ FileName, RawContent, ... }`); the SDK
 * base64-encodes the bytes for the wire automatically. So there is no MIME string
 * to assemble and no extra dependency (nodemailer) — one `@aws-sdk/client-sesv2`
 * call. Verified against the AWS SES Developer Guide "Working with email
 * attachments in SES" at implementation time.
 *
 * SAFETY (mirrors src/lib/cdn/invalidate.ts)
 * NEVER throws: a send failure returns a typed `{ ok: false, reason }` so the
 * caller can surface the FUNCTIONALITY §7 "download instead" fallback rather than
 * 500. The AWS call is time-boxed by an AbortController. When `EMAIL_SENDER` is
 * unset (local dev, CI, tests, or any stage without a verified SES identity) the
 * module is a no-op that returns `not_configured` and touches no AWS — same
 * env-gated pattern as translation + CDN invalidation.
 */

import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2'

/** A single email attachment (the quote PDF). `content` is raw bytes. */
export interface EmailAttachment {
  filename: string
  content: Buffer
  /** IANA media type; defaults to application/pdf. */
  contentType?: string
}

/** A fully-resolved message (subject/body already in the recipient's language). */
export interface SendEmailParams {
  to: string
  subject: string
  html: string
  text: string
  /** Reply-To (typically the company's public inbox). Omitted when null. */
  replyTo?: string | null
  attachment?: EmailAttachment
}

/**
 * Outcome of a send. `not_configured` = no verified sender on this stage (a
 * silent, expected state locally/CI); `send_failed` = SES rejected/timed out (a
 * real failure the UI turns into the download fallback). Never an exception.
 */
export type SendResult = { ok: true } | { ok: false; reason: 'not_configured' | 'send_failed' }

/**
 * Test seam (mirrors __set…ForTests in cdn/invalidate + translation/provider):
 * when set, replaces the real SES call so the module can be exercised with no AWS
 * access. Receives the resolved sender + the params, so a test can assert the
 * exact payload the route built.
 */
type SendImpl = (sender: string, params: SendEmailParams) => Promise<void>
let sendForTests: SendImpl | null = null
export function __setSesSendForTests(impl: SendImpl | null): void {
  sendForTests = impl
}

/** Verified From address for this stage, or null when email is not configured. */
export function getEmailSender(): string | null {
  const value = process.env.EMAIL_SENDER?.trim()
  return value ? value : null
}

/** True when a verified SES sender is wired for this stage. */
export function isEmailConfigured(): boolean {
  return getEmailSender() !== null
}

/**
 * Pragmatic, deliberately-simple RFC-5321-ish recipient check: exactly one `@`,
 * non-empty local part, and a dotted domain with a 2+ char TLD. This is a sanity
 * gate to reject obvious typos before spending an SES call — SES itself is the
 * real authority on deliverability (and bounces are handled out of band). It is
 * intentionally NOT a full RFC 5322 grammar (those regexes are unreadable and
 * still wrong at the edges).
 */
export function isValidEmail(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 254) return false
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(trimmed)
}

/** Hard ceiling on the SES call so it can never hang a request. */
const AWS_CALL_TIMEOUT_MS = 8_000

let client: SESv2Client | null = null
function getClient(): SESv2Client {
  if (!client) {
    client = new SESv2Client({
      region: process.env.AWS_REGION || 'eu-central-1',
      maxAttempts: 2,
    })
  }
  return client
}

/**
 * Send one transactional email. Returns a typed result and NEVER throws. A no-op
 * returning `not_configured` when `EMAIL_SENDER` is unset (so local dev / CI need
 * no SES access). See the module header for the safety contract.
 */
export async function sendEmail(params: SendEmailParams): Promise<SendResult> {
  const sender = getEmailSender()
  if (!sender) return { ok: false, reason: 'not_configured' }

  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new Error('SES send timed out')),
    AWS_CALL_TIMEOUT_MS,
  )
  try {
    if (sendForTests) {
      await sendForTests(sender, params)
    } else {
      await getClient().send(
        new SendEmailCommand({
          FromEmailAddress: sender,
          Destination: { ToAddresses: [params.to] },
          ReplyToAddresses: params.replyTo ? [params.replyTo] : undefined,
          Content: {
            Simple: {
              Subject: { Data: params.subject, Charset: 'UTF-8' },
              Body: {
                Text: { Data: params.text, Charset: 'UTF-8' },
                Html: { Data: params.html, Charset: 'UTF-8' },
              },
              // Native SES v2 attachments (2025-04+): the SDK base64-encodes
              // `RawContent` for the wire; `ContentTransferEncoding: BASE64`
              // tells SES how to encode it into the final MIME message.
              Attachments: params.attachment
                ? [
                    {
                      FileName: params.attachment.filename,
                      RawContent: params.attachment.content,
                      ContentType: params.attachment.contentType ?? 'application/pdf',
                      ContentDisposition: 'ATTACHMENT',
                      ContentTransferEncoding: 'BASE64',
                    },
                  ]
                : undefined,
            },
          },
        }),
        { abortSignal: controller.signal },
      )
    }
    return { ok: true }
  } catch (err) {
    console.warn('[email] SES send failed:', (err as Error)?.message ?? err)
    return { ok: false, reason: 'send_failed' }
  } finally {
    clearTimeout(timer)
  }
}
