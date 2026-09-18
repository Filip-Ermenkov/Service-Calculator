/**
 * @vitest-environment node
 *
 * Admin password recovery + Payload's serverURL (2026-09-16).
 *
 * What is pinned here, and why each piece exists:
 *   • `resolveServerUrl` — the ONE origin Payload may put into emails and accept
 *     cookie-auth from. Wrong value = admin locked out of their own stage; empty
 *     value = relative reset links + an open CSRF allowlist (the pre-fix state).
 *   • The reset email template — OWASP forgot-password rules (link only, expiry
 *     stated, "ignore if not you", nothing secret besides the token).
 *   • The SES-backed Payload email adapter — message normalisation, the
 *     not-configured branches (dev prints the body; production only alerts), and
 *     the never-throws contract.
 *   • The real `forgotPassword` operation against Postgres — proves Payload
 *     actually calls the adapter with an ABSOLUTE `serverURL`-based link whose
 *     token is the one stored on the user, and that the endpoint is rate-limited.
 *
 * Runs in `node` (not jsdom) because the second half boots Payload.
 */

import { getPayload, type Payload } from 'payload'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import config from '@/payload.config'
import { FORGOT_PASSWORD_RATE_LIMIT, RESET_PASSWORD_EXPIRATION_MS } from '@/collections/Users'
import {
  payloadEmailAdapter,
  plainTextFromHtml,
  toAddressList,
} from '@/lib/email/payloadEmailAdapter'
import { renderResetPasswordEmail, resetPasswordSubject } from '@/lib/email/resetPasswordEmail'
import { __setSesSendForTests, type SendEmailParams } from '@/lib/email/ses'
import { readSstStage } from '@/lib/observability/stage'
import { __resetRateLimitForTests } from '@/lib/rateLimit'
import {
  isDeployedWithoutServerUrl,
  LOCAL_DEV_ORIGIN,
  normalizeOrigin,
  PRODUCTION_ORIGIN,
  resolveServerUrl,
} from '@/lib/serverUrl'

// ─────────────────────────────────────────────────────────────────────────────
describe('serverUrl.ts — resolveServerUrl() picks the one trusted origin per environment', () => {
  const prodStage = JSON.stringify({ name: 'bulbau-lu', stage: 'production' })
  const stagingStage = JSON.stringify({ name: 'bulbau-lu', stage: 'staging' })

  it('uses NEXT_PUBLIC_SITE_URL when set, normalised to a bare origin', () => {
    expect(
      resolveServerUrl({ NEXT_PUBLIC_SITE_URL: 'https://d20kjuz86nwvyp.cloudfront.net/', NODE_ENV: 'production' }),
    ).toBe('https://d20kjuz86nwvyp.cloudfront.net')
    expect(resolveServerUrl({ NEXT_PUBLIC_SITE_URL: ' https://Bulbau.lu/en ' })).toBe('https://bulbau.lu')
  })

  it('falls back to the production domain ONLY on the SST production stage', () => {
    expect(resolveServerUrl({ NODE_ENV: 'production', SST_RESOURCE_App: prodStage })).toBe(PRODUCTION_ORIGIN)
    // A CI `next build` / `next start` runs with NODE_ENV=production but is not a
    // stage — it must NOT be treated as production (it would reject its own
    // localhost origin and mint bulbau.lu media URLs on the CI runner).
    expect(resolveServerUrl({ NODE_ENV: 'production' })).toBe('')
  })

  it('uses localhost:3000 outside production mode (next dev, vitest, payload run)', () => {
    expect(resolveServerUrl({ NODE_ENV: 'development' })).toBe(LOCAL_DEV_ORIGIN)
    expect(resolveServerUrl({ NODE_ENV: 'test' })).toBe(LOCAL_DEV_ORIGIN)
    expect(resolveServerUrl({})).toBe(LOCAL_DEV_ORIGIN)
  })

  it('leaves a deployed NON-production stage without SiteUrl at "" (never bulbau.lu — that would lock the staging admin out)', () => {
    const env = { NODE_ENV: 'production', SST_RESOURCE_App: stagingStage }
    expect(resolveServerUrl(env)).toBe('')
    expect(isDeployedWithoutServerUrl(env)).toBe(true)
    expect(isDeployedWithoutServerUrl({ ...env, NEXT_PUBLIC_SITE_URL: 'https://x.cloudfront.net' })).toBe(false)
    expect(isDeployedWithoutServerUrl({ NODE_ENV: 'production' })).toBe(false) // CI, not a stage
  })

  it('ignores a malformed or non-http NEXT_PUBLIC_SITE_URL rather than trusting it', () => {
    expect(normalizeOrigin('not a url')).toBeNull()
    expect(normalizeOrigin('ftp://bulbau.lu')).toBeNull()
    expect(normalizeOrigin('javascript:alert(1)')).toBeNull()
    expect(normalizeOrigin('')).toBeNull()
    expect(resolveServerUrl({ NEXT_PUBLIC_SITE_URL: 'not a url', NODE_ENV: 'development' })).toBe(LOCAL_DEV_ORIGIN)
  })

  it('readSstStage() reads only what SST declared (no NODE_ENV fallback)', () => {
    expect(readSstStage({ SST_RESOURCE_App: prodStage })).toBe('production')
    expect(readSstStage({ SST_STAGE: 'filip' })).toBe('filip')
    expect(readSstStage({ SST_RESOURCE_App: '{broken', SST_STAGE: 'x' })).toBe('x')
    expect(readSstStage({})).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('resetPasswordEmail.ts — the branded admin reset email', () => {
  const mail = renderResetPasswordEmail({
    resetUrl: 'https://bulbau.lu/admin/reset/abc123',
    expiresInMinutes: 60,
    companyName: 'Bulbau',
  })

  it('carries the absolute reset link in both parts and states the validity window', () => {
    expect(mail.subject).toBe(resetPasswordSubject('Bulbau'))
    expect(mail.html).toContain('href="https://bulbau.lu/admin/reset/abc123"')
    expect(mail.text).toContain('https://bulbau.lu/admin/reset/abc123')
    expect(mail.html).toContain('valid for 1 hour')
    expect(mail.text).toContain('can be used once')
  })

  it('tells the recipient what to do if they did not ask, and never mentions a password value', () => {
    expect(mail.text).toMatch(/If you did not request this/)
    expect(mail.text).not.toMatch(/password[:=]\s*\S/i)
  })

  it('escapes interpolated values in the HTML part', () => {
    const hostile = renderResetPasswordEmail({
      resetUrl: 'https://bulbau.lu/admin/reset/x"><script>alert(1)</script>',
      expiresInMinutes: 30,
      companyName: '<b>Evil</b>',
    })
    expect(hostile.html).not.toContain('<script>')
    expect(hostile.html).toContain('&lt;b&gt;Evil&lt;/b&gt;')
    expect(hostile.html).toContain('valid for 30 minutes')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('payloadEmailAdapter.ts — message normalisation', () => {
  it('toAddressList accepts a string, an address object, or an array of either', () => {
    expect(toAddressList('a@example.com')).toEqual(['a@example.com'])
    expect(toAddressList({ name: 'A', address: ' a@example.com ' })).toEqual(['a@example.com'])
    expect(toAddressList(['a@example.com', { address: 'b@example.com' }, { name: 'nobody' }])).toEqual([
      'a@example.com',
      'b@example.com',
    ])
    expect(toAddressList(undefined)).toEqual([])
  })

  it('plainTextFromHtml keeps link targets, paragraph breaks and decodes entities', () => {
    const text = plainTextFromHtml(
      '<html><head><style>p{}</style></head><body><h1>Title &amp; more</h1><p>Hello<br>there</p>' +
        '<p><a href="https://x.test/reset/1">Choose a new password</a></p>' +
        '<p><a href="https://x.test/reset/1">https://x.test/reset/1</a></p></body></html>',
    )
    expect(text).toContain('Title & more')
    expect(text).toContain('Hello\nthere')
    expect(text).toContain('Choose a new password (https://x.test/reset/1)')
    // A link whose label IS the URL is not doubled.
    expect(text.match(/https:\/\/x\.test\/reset\/1/g)?.length).toBe(2)
    expect(text).not.toMatch(/<[a-z]/)
  })

  it('plainTextFromHtml is a tokenizer, not a regex chain: nested containers and entity order cannot leak markup', () => {
    // The two CodeQL findings the 2026-09-18 rewrite closed: a regex that strips
    // `<style…</style>` once leaves `<sty<style>le>` behind, and decoding
    // `&amp;` before `&lt;` turns a literal `&amp;lt;` into `<`.
    const text = plainTextFromHtml(
      '<sty<style>le>x</style>le><p>A &amp;lt; B</p><script>alert(1)</script><SCRIPT>2</SCRIPT>' +
        '<p>Unclosed <a href="https://x.test/a">link',
    )
    expect(text).not.toMatch(/<[a-z]/i)
    expect(text).not.toContain('alert')
    // `&amp;lt;` is one entity (`&amp;`) followed by literal `lt;` → `&lt;`, never `<`.
    expect(text).toContain('A &lt; B')
    expect(text).not.toContain('A < B')
    // A link that never closes keeps its label.
    expect(text).toContain('link')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('payloadEmailAdapter.ts — sendEmail branches', () => {
  const ORIGINAL_ENV = { ...process.env }
  const fakePayload = {} as unknown as Parameters<ReturnType<typeof payloadEmailAdapter>>[0]['payload']

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
    __setSesSendForTests(null)
    vi.restoreAllMocks()
  })

  it('when EMAIL_SENDER is set: sends via SES with our friendly From, all recipients, and a derived text part', async () => {
    process.env.EMAIL_SENDER = 'info@bulbau.lu'
    const sent: Array<{ sender: string; params: SendEmailParams }> = []
    __setSesSendForTests(async (sender, params) => {
      sent.push({ sender, params })
    })
    const adapter = payloadEmailAdapter({ fromName: 'Bulbau' })({ payload: fakePayload })
    expect(adapter.defaultFromAddress).toBe('info@bulbau.lu')
    expect(adapter.defaultFromName).toBe('Bulbau')

    const result = await adapter.sendEmail({
      from: '"Bulbau" <info@bulbau.lu>', // exactly how Payload formats it
      to: ['admin@bulbau.lu', { address: 'second@bulbau.lu' }],
      replyTo: 'office@bulbau.lu',
      subject: 'Reset your Bulbau admin password',
      html: '<p>Hi</p><p><a href="https://bulbau.lu/admin/reset/t0k3n">Choose a new password</a></p>',
    })
    expect(result).toEqual({ ok: true })
    expect(sent).toHaveLength(1)
    expect(sent[0].params.to).toEqual(['admin@bulbau.lu', 'second@bulbau.lu'])
    expect(sent[0].params.from).toBe('"Bulbau" <info@bulbau.lu>')
    expect(sent[0].params.replyTo).toBe('office@bulbau.lu')
    expect(sent[0].params.text).toContain('Choose a new password (https://bulbau.lu/admin/reset/t0k3n)')
  })

  it('never lets the From ADDRESS drift from the verified sender (rebuilds it, keeps only the display name)', async () => {
    process.env.EMAIL_SENDER = 'info@bulbau.lu'
    const sent: SendEmailParams[] = []
    __setSesSendForTests(async (_sender, params) => {
      sent.push(params)
    })
    const adapter = payloadEmailAdapter({ fromName: 'Bulbau' })({ payload: fakePayload })
    await adapter.sendEmail({ from: { name: 'X', address: 'spoof@evil.example' }, to: 'a@b.co', subject: 's', html: '<p>x</p>' })
    expect(sent[0].from).toBe('"Bulbau" <info@bulbau.lu>')
  })

  it('when EMAIL_SENDER is unset outside production: prints the body to the console (so the flow is completable locally) and returns not_configured', async () => {
    delete process.env.EMAIL_SENDER
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const adapter = payloadEmailAdapter({ fromName: 'Bulbau' })({ payload: fakePayload })

    const result = await adapter.sendEmail({ to: 'admin@bulbau.lu', subject: 'Reset', html: '<p><a href="http://localhost:3000/admin/reset/abc">go</a></p>' })
    expect(result).toEqual({ ok: false, reason: 'not_configured' })
    expect(info).toHaveBeenCalledTimes(1)
    expect(String(info.mock.calls[0][0])).toContain('http://localhost:3000/admin/reset/abc')
    expect(error).not.toHaveBeenCalled() // no OPS_ALERT locally
  })

  it('when EMAIL_SENDER is unset IN PRODUCTION: emits exactly one OPS_ALERT and never logs the body', async () => {
    delete process.env.EMAIL_SENDER
    vi.stubEnv('NODE_ENV', 'production')
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const adapter = payloadEmailAdapter({ fromName: 'Bulbau' })({ payload: fakePayload })

    const result = await adapter.sendEmail({ to: 'admin@bulbau.lu', subject: 'Reset', html: '<p><a href="https://bulbau.lu/admin/reset/secret-token">go</a></p>' })
    expect(result).toEqual({ ok: false, reason: 'not_configured' })
    expect(info).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledTimes(1)
    const line = String(error.mock.calls[0][0])
    expect(line.startsWith('OPS_ALERT ')).toBe(true)
    expect(line).toContain('email.payload.notConfigured')
    expect(line).not.toContain('secret-token')
    expect(line).not.toContain('admin@bulbau.lu')
    vi.unstubAllEnvs()
  })

  it('a message with no usable recipient is refused without throwing', async () => {
    process.env.EMAIL_SENDER = 'info@bulbau.lu'
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let called = false
    __setSesSendForTests(async () => {
      called = true
    })
    const adapter = payloadEmailAdapter({ fromName: 'Bulbau' })({ payload: fakePayload })
    await expect(adapter.sendEmail({ to: [{ name: 'nobody' }], subject: 's', html: '<p>x</p>' })).resolves.toEqual({
      ok: false,
      reason: 'no_recipient',
    })
    expect(called).toBe(false)
  })

  it('never throws even when SES itself fails (Payload keeps its uniform success response)', async () => {
    process.env.EMAIL_SENDER = 'info@bulbau.lu'
    vi.spyOn(console, 'error').mockImplementation(() => {})
    __setSesSendForTests(async () => {
      throw new Error('SES down')
    })
    const adapter = payloadEmailAdapter({ fromName: 'Bulbau' })({ payload: fakePayload })
    await expect(adapter.sendEmail({ to: 'a@b.co', subject: 's', html: '<p>x</p>' })).resolves.toEqual({
      ok: false,
      reason: 'send_failed',
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('forgot-password end to end (real Payload + Postgres)', () => {
  let payload: Payload
  let adminId: number | string
  const adminEmail = `forgot-int-${Date.now()}@example.com`
  const ORIGINAL_ENV = { ...process.env }
  let sent: Array<{ sender: string; params: SendEmailParams }> = []

  beforeAll(async () => {
    payload = await getPayload({ config: await config })
    const admin = await payload.create({
      collection: 'users',
      data: { email: adminEmail, password: 'a-valid-test-password-123' },
    })
    adminId = admin.id
  })

  beforeEach(() => {
    process.env.EMAIL_SENDER = 'info@bulbau.lu'
    sent = []
    __setSesSendForTests(async (sender, params) => {
      sent.push({ sender, params })
    })
    __resetRateLimitForTests()
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
    __setSesSendForTests(null)
    __resetRateLimitForTests()
  })

  afterAll(async () => {
    await payload.delete({ collection: 'users', id: adminId }).catch(() => undefined)
  })

  it('the config resolved a serverURL for this environment (tests run outside production mode)', async () => {
    expect(payload.config.serverURL).toBe(LOCAL_DEV_ORIGIN)
    // Payload's sanitizer copies serverURL onto the CSRF allowlist — the
    // mechanism tests/int/rest.int.spec.ts proves from the HTTP side.
    expect(payload.config.csrf).toContain(LOCAL_DEV_ORIGIN)
    expect(payload.email.name).toBe('bulbau-ses-v2')
  })

  it('emails an ABSOLUTE, serverURL-based reset link carrying the token stored on the user, with the branded subject', async () => {
    const token = await payload.forgotPassword({ collection: 'users', data: { email: adminEmail } })
    expect(typeof token).toBe('string')
    expect((token as string).length).toBeGreaterThanOrEqual(40) // 20 random bytes, hex

    expect(sent).toHaveLength(1)
    const { params } = sent[0]
    expect(params.to).toEqual([adminEmail])
    expect(params.subject).toBe(resetPasswordSubject('Bulbau'))
    expect(params.from).toBe('"Bulbau" <info@bulbau.lu>')
    expect(params.html).toContain(`href="${LOCAL_DEV_ORIGIN}/admin/reset/${token}"`)
    expect(params.text).toContain(`${LOCAL_DEV_ORIGIN}/admin/reset/${token}`)
    // Never a relative link (the pre-fix state) and never the request's Host.
    expect(params.html).not.toContain('href="/admin/reset/')

    const stored = await payload.findByID({
      collection: 'users',
      id: adminId,
      overrideAccess: true,
      showHiddenFields: true,
    })
    expect((stored as { resetPasswordToken?: string }).resetPasswordToken).toBe(token)
    const exp = new Date((stored as { resetPasswordExpiration?: string }).resetPasswordExpiration ?? 0).getTime()
    expect(exp - Date.now()).toBeGreaterThan(RESET_PASSWORD_EXPIRATION_MS - 60_000)
    expect(exp - Date.now()).toBeLessThanOrEqual(RESET_PASSWORD_EXPIRATION_MS)
  })

  it('an unknown address sends nothing and returns the same shape as far as the caller can tell (no enumeration)', async () => {
    const result = await payload.forgotPassword({
      collection: 'users',
      data: { email: `nobody-${Date.now()}@example.com` },
    })
    expect(result).toBeNull()
    expect(sent).toHaveLength(0)
  })

  it('is rate-limited per address: the 6th request in the window is refused with 429 before any lookup or send', async () => {
    for (let i = 0; i < FORGOT_PASSWORD_RATE_LIMIT.max; i++) {
      await payload.forgotPassword({ collection: 'users', data: { email: adminEmail } })
    }
    expect(sent).toHaveLength(FORGOT_PASSWORD_RATE_LIMIT.max)

    await expect(
      payload.forgotPassword({ collection: 'users', data: { email: adminEmail } }),
    ).rejects.toMatchObject({ status: 429 })
    expect(sent).toHaveLength(FORGOT_PASSWORD_RATE_LIMIT.max) // nothing more went out
  })

  it('the per-address budget is case-insensitive and does not leak across addresses', async () => {
    for (let i = 0; i < FORGOT_PASSWORD_RATE_LIMIT.max; i++) {
      await payload.forgotPassword({ collection: 'users', data: { email: adminEmail.toUpperCase() } })
    }
    await expect(
      payload.forgotPassword({ collection: 'users', data: { email: adminEmail } }),
    ).rejects.toMatchObject({ status: 429 })
    // A different address from the same (unknown, Local-API) client is still
    // capped by the per-IP budget — both keys are enforced together.
    await expect(
      payload.forgotPassword({ collection: 'users', data: { email: `other-${Date.now()}@example.com` } }),
    ).rejects.toMatchObject({ status: 429 })
  })
})
