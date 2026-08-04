import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  renderQuoteEmail,
  renderQuoteEmailHtml,
  renderQuoteEmailText,
  type QuoteEmailContent,
} from '@/lib/email/quoteEmail'
import {
  __setSesSendForTests,
  getEmailSender,
  isEmailConfigured,
  isValidEmail,
  sendEmail,
  type SendEmailParams,
} from '@/lib/email/ses'

// Pure coverage for the quote-email path (src/lib/email/*). No AWS / network:
// the SES SendEmail call is exercised through the test seam (__setSesSendForTests).
// The real end-to-end delivery (visitor → SES → inbox) is covered by the manual
// guide, since it needs a verified SES identity + production access.

const SENDER = 'quotes@bulbau.lu'

describe('email/ses.ts — SES send path', () => {
  const OLD = { ...process.env }

  beforeEach(() => {
    process.env = { ...OLD }
  })
  afterEach(() => {
    __setSesSendForTests(null)
    process.env = { ...OLD }
    vi.restoreAllMocks()
  })

  describe('isValidEmail()', () => {
    it.each([
      'a@b.co',
      'first.last@sub.example.com',
      'user+tag@example.io',
    ])('accepts %s', (addr) => {
      expect(isValidEmail(addr)).toBe(true)
    })

    it.each([
      '',
      '   ',
      'nope',
      'no@domain',
      'no@domain.',
      'two@@at.com',
      'spaces in@email.com',
      'trailing@dot.c',
      42 as unknown,
      null as unknown,
      undefined as unknown,
    ])('rejects %p', (addr) => {
      expect(isValidEmail(addr)).toBe(false)
    })

    it('rejects an address longer than 254 chars', () => {
      const huge = `${'x'.repeat(250)}@e.com`
      expect(isValidEmail(huge)).toBe(false)
    })
  })

  describe('configuration gate', () => {
    it('getEmailSender is null and isEmailConfigured is false when EMAIL_SENDER is unset', () => {
      delete process.env.EMAIL_SENDER
      expect(getEmailSender()).toBeNull()
      expect(isEmailConfigured()).toBe(false)
    })
    it('trims and returns the sender when set', () => {
      process.env.EMAIL_SENDER = `  ${SENDER}  `
      expect(getEmailSender()).toBe(SENDER)
      expect(isEmailConfigured()).toBe(true)
    })
    it('treats a whitespace-only EMAIL_SENDER as unset', () => {
      process.env.EMAIL_SENDER = '   '
      expect(getEmailSender()).toBeNull()
      expect(isEmailConfigured()).toBe(false)
    })
  })

  describe('sendEmail()', () => {
    const params: SendEmailParams = {
      to: 'visitor@example.com',
      subject: 'Your price estimate — Solar',
      html: '<p>hi</p>',
      text: 'hi',
      replyTo: 'info@bulbau.lu',
      attachment: { filename: 'quote.pdf', content: Buffer.from('%PDF-1.4 fake'), contentType: 'application/pdf' },
    }

    it('is a no-op returning not_configured when EMAIL_SENDER is unset (never touches the seam)', async () => {
      delete process.env.EMAIL_SENDER
      const send = vi.fn<(sender: string, p: SendEmailParams) => Promise<void>>().mockResolvedValue()
      __setSesSendForTests(send)
      const result = await sendEmail(params)
      expect(result).toEqual({ ok: false, reason: 'not_configured' })
      expect(send).not.toHaveBeenCalled()
    })

    it('sends via the seam and returns ok when configured, passing the resolved sender + params', async () => {
      process.env.EMAIL_SENDER = SENDER
      const send = vi.fn<(sender: string, p: SendEmailParams) => Promise<void>>().mockResolvedValue()
      __setSesSendForTests(send)
      const result = await sendEmail(params)
      expect(result).toEqual({ ok: true })
      expect(send).toHaveBeenCalledTimes(1)
      const [sender, forwarded] = send.mock.calls[0]
      expect(sender).toBe(SENDER)
      expect(forwarded.to).toBe('visitor@example.com')
      expect(forwarded.attachment?.filename).toBe('quote.pdf')
    })

    it('returns send_failed (never throws) when the seam throws', async () => {
      process.env.EMAIL_SENDER = SENDER
      __setSesSendForTests(async () => {
        throw new Error('SES exploded')
      })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const result = await sendEmail(params)
      expect(result).toEqual({ ok: false, reason: 'send_failed' })
      expect(warn).toHaveBeenCalled()
    })
  })
})

describe('email/quoteEmail.ts — body assembly', () => {
  const base: QuoteEmailContent = {
    heading: 'Your price estimate',
    paragraphs: ['Hello,', 'Thank you for your interest in Solar Panels.', 'This is an estimate.'],
    totalLine: 'Estimated total: €1,234',
    signoff: 'Best regards, bulbau',
    phoneLabel: 'Phone',
    emailLabel: 'Email',
    company: { name: 'bulbau', phone: '+352 123', email: 'info@bulbau.lu' },
  }

  it('HTML includes the heading, every paragraph, the total line and both contact pairs', () => {
    const html = renderQuoteEmailHtml(base)
    expect(html).toContain('Your price estimate')
    for (const p of base.paragraphs) expect(html).toContain(p)
    expect(html).toContain('Estimated total: €1,234')
    expect(html).toContain('Phone: +352 123')
    expect(html).toContain('Email: info@bulbau.lu')
  })

  it('HTML-escapes interpolated values (no raw injection)', () => {
    const html = renderQuoteEmailHtml({
      ...base,
      paragraphs: ['<script>alert(1)</script>'],
      company: { name: 'x', phone: null, email: null },
    })
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('omits the total line in the §7 contact-us state (totalLine null)', () => {
    const html = renderQuoteEmailHtml({ ...base, totalLine: null })
    const text = renderQuoteEmailText({ ...base, totalLine: null })
    expect(html).not.toContain('Estimated total')
    expect(text).not.toContain('Estimated total')
  })

  it('skips a contact pair whose value is empty', () => {
    const text = renderQuoteEmailText({
      ...base,
      company: { name: 'bulbau', phone: null, email: 'info@bulbau.lu' },
    })
    expect(text).not.toContain('Phone:')
    expect(text).toContain('Email: info@bulbau.lu')
  })

  it('plain-text alternative contains the heading, paragraphs and signoff', () => {
    const text = renderQuoteEmailText(base)
    expect(text).toContain('Your price estimate')
    expect(text).toContain('Thank you for your interest in Solar Panels.')
    expect(text).toContain('Best regards, bulbau')
  })

  it('renderQuoteEmail returns both html and text parts', () => {
    const { html, text } = renderQuoteEmail(base)
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(typeof text).toBe('string')
    expect(text.length).toBeGreaterThan(0)
  })
})
