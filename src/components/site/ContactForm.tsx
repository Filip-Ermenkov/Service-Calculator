'use client'

/**
 * Public contact form (Phase 6 — FUNCTIONALITY §6, TECHSPEC §6.8).
 *
 * Posts { name, email, subject?, message, turnstileToken, company } as JSON to
 * /api/contact, which validates + spam-checks + relays it to the company inbox
 * via SES. The message is never stored (GDPR minimisation).
 *
 * Spam defences visible here: a hidden HONEYPOT field (`company`) a human never
 * sees but bots auto-fill, and the Cloudflare TURNSTILE widget (rendered only
 * when NEXT_PUBLIC_TURNSTILE_SITE_KEY is set — otherwise it's a no-op and the
 * server skips verification too). The server re-checks everything; this is UX.
 *
 * Accessibility: real <label>s, `aria-invalid` on rejected fields, a single
 * `role="alert"` status region, and `aria-busy` on the submit button.
 */

import { useState, type FormEvent } from 'react'
import { useLocale, useTranslations } from 'next-intl'

import { TurnstileWidget, isTurnstileEnabled } from '@/components/site/TurnstileWidget'

type Status =
  | 'idle'
  | 'submitting'
  | 'success'
  | 'validation'
  | 'rateLimited'
  | 'turnstile'
  | 'unavailable'
  | 'error'

export function ContactForm({ phone, email }: { phone?: string | null; email?: string | null }) {
  const t = useTranslations('Contact')
  const locale = useLocale()

  const [name, setName] = useState('')
  const [fromEmail, setFromEmail] = useState('')
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [honeypot, setHoneypot] = useState('') // must stay empty (hidden)
  const [status, setStatus] = useState<Status>('idle')
  const [invalidFields, setInvalidFields] = useState<string[]>([])

  const turnstileOn = isTurnstileEnabled()
  const [token, setToken] = useState<string | null>(null)
  const [resetSignal, setResetSignal] = useState(0)

  const isInvalid = (field: string) => invalidFields.includes(field)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (status === 'submitting') return

    // Client-side pre-checks mirror the server's, for instant feedback. The
    // server re-validates authoritatively regardless.
    const nextInvalid: string[] = []
    if (!name.trim()) nextInvalid.push('name')
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(fromEmail.trim())) nextInvalid.push('email')
    if (!message.trim()) nextInvalid.push('message')
    if (nextInvalid.length > 0) {
      setInvalidFields(nextInvalid)
      setStatus('validation')
      return
    }
    if (turnstileOn && !token) {
      setStatus('turnstile')
      return
    }

    setInvalidFields([])
    setStatus('submitting')
    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          email: fromEmail.trim(),
          subject: subject.trim() || undefined,
          message: message.trim(),
          locale,
          turnstileToken: token ?? undefined,
          company: honeypot, // honeypot — empty for a real user
        }),
      })

      if (res.ok) {
        setStatus('success')
        return
      }

      // A Turnstile token is single-use: reset the widget so the visitor can
      // retry any recoverable failure with a fresh challenge.
      if (turnstileOn) {
        setResetSignal((n) => n + 1)
        setToken(null)
      }

      if (res.status === 429) {
        setStatus('rateLimited')
        return
      }
      const data = (await res.json().catch(() => ({}))) as { error?: string; fields?: string[] }
      if (res.status === 400 && data.error === 'validation_error') {
        setInvalidFields(data.fields ?? [])
        setStatus('validation')
        return
      }
      if (data.error === 'turnstile_failed' || data.error === 'turnstile_unavailable') {
        setStatus('turnstile')
        return
      }
      if (res.status === 503) {
        setStatus('unavailable')
        return
      }
      setStatus('error')
    } catch (err) {
      console.error('[contact] submit failed:', err)
      if (turnstileOn) {
        setResetSignal((n) => n + 1)
        setToken(null)
      }
      setStatus('error')
    }
  }

  if (status === 'success') {
    return (
      <div className="contact-form-success" role="status">
        <h3 style={{ margin: '0 0 0.5rem', color: 'var(--g900)' }}>{t('successTitle')}</h3>
        <p style={{ margin: 0, color: 'var(--g600)' }}>{t('successBody')}</p>
      </div>
    )
  }

  const statusMessage =
    status === 'validation'
      ? t('errorValidation')
      : status === 'rateLimited'
        ? t('errorRateLimited')
        : status === 'turnstile'
          ? t('errorTurnstile')
          : status === 'unavailable'
            ? t('errorUnavailable', { phone: phone ?? '—', email: email ?? '—' })
            : status === 'error'
              ? t('errorGeneric', { phone: phone ?? '—', email: email ?? '—' })
              : null

  return (
    <form className="contact-form" onSubmit={handleSubmit} noValidate>
      <div className="form-field">
        <label className="form-label" htmlFor="contact-name">
          {t('nameLabel')} <span className="form-required" aria-hidden="true">*</span>
        </label>
        <input
          id="contact-name"
          className="form-input"
          type="text"
          autoComplete="name"
          value={name}
          maxLength={120}
          required
          aria-required="true"
          aria-invalid={isInvalid('name') || undefined}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className="form-field">
        <label className="form-label" htmlFor="contact-email">
          {t('emailLabel')} <span className="form-required" aria-hidden="true">*</span>
        </label>
        <input
          id="contact-email"
          className="form-input"
          type="email"
          inputMode="email"
          autoComplete="email"
          value={fromEmail}
          maxLength={254}
          required
          aria-required="true"
          aria-invalid={isInvalid('email') || undefined}
          onChange={(e) => setFromEmail(e.target.value)}
        />
      </div>

      <div className="form-field">
        <label className="form-label" htmlFor="contact-subject">
          {t('subjectLabel')}
        </label>
        <input
          id="contact-subject"
          className="form-input"
          type="text"
          value={subject}
          maxLength={160}
          onChange={(e) => setSubject(e.target.value)}
        />
      </div>

      <div className="form-field">
        <label className="form-label" htmlFor="contact-message">
          {t('messageLabel')} <span className="form-required" aria-hidden="true">*</span>
        </label>
        <textarea
          id="contact-message"
          className="form-textarea"
          rows={6}
          value={message}
          maxLength={5000}
          required
          aria-required="true"
          aria-invalid={isInvalid('message') || undefined}
          onChange={(e) => setMessage(e.target.value)}
        />
      </div>

      {/* Honeypot: a hidden field a real user never sees, but naive spam bots
          auto-fill. Hidden by OFF-SCREEN POSITIONING (not display:none): current
          best practice, because it also catches bots that skip display:none fields,
          while remaining invisible to humans. Three things keep it from causing a
          FALSE POSITIVE (silently dropping a real visitor): a non-real field name
          (`contact-ref`, not "company"/"phone"/etc. that browsers autofill),
          `autocomplete="off"`, and `aria-hidden` + `tabIndex=-1` so it's off the
          tab order and unseen by assistive tech. Turnstile is the real control;
          this is a cheap secondary net that must never flag a human. */}
      <div
        aria-hidden="true"
        style={{ position: 'absolute', left: '-9999px', width: '1px', height: '1px', overflow: 'hidden' }}
      >
        <label htmlFor="contact-ref">Leave this field empty</label>
        <input
          id="contact-ref"
          name="contact-ref"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={honeypot}
          onChange={(e) => setHoneypot(e.target.value)}
        />
      </div>

      {turnstileOn && (
        <TurnstileWidget onToken={setToken} action="contact" locale={locale} resetSignal={resetSignal} />
      )}

      {statusMessage && (
        <p className="price-note" role="alert" style={{ color: 'var(--orange)', marginTop: '0.75rem' }}>
          {statusMessage}
        </p>
      )}

      <button
        type="submit"
        className="btn btn-primary"
        disabled={status === 'submitting'}
        aria-busy={status === 'submitting' || undefined}
        style={{ marginTop: '1rem' }}
      >
        {status === 'submitting' ? t('submitting') : t('submit')}
      </button>
    </form>
  )
}
