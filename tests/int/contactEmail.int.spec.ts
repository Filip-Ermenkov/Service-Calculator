import { describe, expect, it } from 'vitest'

import {
  renderContactEmail,
  type ContactEmailLabels,
  type ContactSubmission,
} from '@/lib/email/contactEmail'

// Pure coverage for the contact-form relay body (src/lib/email/contactEmail.ts).
// The full route behaviour (rate limit, honeypot, Turnstile, SES send) is covered
// by the manual E2E guide + the turnstile/ses unit suites.

const labels: ContactEmailLabels = {
  heading: 'New message from the website contact form',
  nameLabel: 'Name',
  emailLabel: 'Email',
  subjectLabel: 'Subject',
  messageLabel: 'Message',
  footerNote: 'Sent via the bulbau.lu contact form.',
}
const PREFIX = 'Contact form:'

const base: ContactSubmission = {
  name: 'Jane Doe',
  email: 'jane@example.com',
  subject: 'Solar quote question',
  message: 'Hello,\nI have a question about my roof.',
}

describe('email/contactEmail.ts — relay body assembly', () => {
  it('derives the subject from the prefix + the message subject', () => {
    const { subject } = renderContactEmail(base, labels, PREFIX)
    expect(subject).toBe('Contact form: Solar quote question')
  })

  it('falls back to the sender name in the subject when no subject is given', () => {
    const { subject } = renderContactEmail({ ...base, subject: null }, labels, PREFIX)
    expect(subject).toBe('Contact form: Jane Doe')
  })

  it('HTML contains name, email, subject and the message (newlines → <br>)', () => {
    const { html } = renderContactEmail(base, labels, PREFIX)
    expect(html).toContain('Jane Doe')
    expect(html).toContain('jane@example.com')
    expect(html).toContain('Solar quote question')
    expect(html).toContain('I have a question about my roof.')
    expect(html).toContain('<br>')
  })

  it('HTML-escapes every attacker-controlled field (no injection)', () => {
    const { html } = renderContactEmail(
      {
        name: '<script>alert(1)</script>',
        email: 'a@b.co',
        subject: '"><img src=x onerror=alert(1)>',
        message: '<b>bold</b> & <i>ital</i>',
      },
      labels,
      PREFIX,
    )
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&amp;')
  })

  it('omits the subject row entirely when no subject is provided', () => {
    const { html, text } = renderContactEmail({ ...base, subject: undefined }, labels, PREFIX)
    expect(html).not.toContain('Subject')
    expect(text).not.toContain('Subject:')
  })

  it('plain-text alternative carries the heading, fields, message and footer', () => {
    const { text } = renderContactEmail(base, labels, PREFIX)
    expect(text).toContain('New message from the website contact form')
    expect(text).toContain('Name: Jane Doe')
    expect(text).toContain('Email: jane@example.com')
    expect(text).toContain('I have a question about my roof.')
    expect(text).toContain('Sent via the bulbau.lu contact form.')
  })
})
