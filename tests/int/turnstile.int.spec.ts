import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  __setTurnstileVerifyForTests,
  getTurnstileSecret,
  isTurnstileConfigured,
  verifyTurnstile,
} from '@/lib/security/turnstile'

// Pure coverage for the Turnstile server verifier (src/lib/security/turnstile.ts).
// No network: the Siteverify call is exercised through the test seam
// (__setTurnstileVerifyForTests). The real end-to-end challenge (widget → token →
// Cloudflare) is covered by the manual guide with real/dummy keys.

const SECRET = '1x0000000000000000000000000000000AA' // Cloudflare "always passes" dummy

describe('security/turnstile.ts — server verification', () => {
  const OLD = { ...process.env }

  beforeEach(() => {
    process.env = { ...OLD }
  })
  afterEach(() => {
    __setTurnstileVerifyForTests(null)
    process.env = { ...OLD }
    vi.restoreAllMocks()
  })

  describe('configuration gate', () => {
    it('getTurnstileSecret is null and isTurnstileConfigured is false when unset', () => {
      delete process.env.TURNSTILE_SECRET_KEY
      expect(getTurnstileSecret()).toBeNull()
      expect(isTurnstileConfigured()).toBe(false)
    })
    it('trims and returns the secret when set', () => {
      process.env.TURNSTILE_SECRET_KEY = `  ${SECRET}  `
      expect(getTurnstileSecret()).toBe(SECRET)
      expect(isTurnstileConfigured()).toBe(true)
    })
    it('treats a whitespace-only secret as unset', () => {
      process.env.TURNSTILE_SECRET_KEY = '   '
      expect(getTurnstileSecret()).toBeNull()
    })
  })

  describe('verifyTurnstile()', () => {
    it('is a skipped no-op (ok:true) when unconfigured, never touching the seam', async () => {
      delete process.env.TURNSTILE_SECRET_KEY
      const seam = vi.fn().mockResolvedValue({ success: true })
      __setTurnstileVerifyForTests(seam)
      const result = await verifyTurnstile('any-token', '1.2.3.4')
      expect(result).toEqual({ ok: true, skipped: true })
      expect(seam).not.toHaveBeenCalled()
    })

    it('fails without a network round-trip when the token is missing/oversized (configured)', async () => {
      process.env.TURNSTILE_SECRET_KEY = SECRET
      const seam = vi.fn().mockResolvedValue({ success: true })
      __setTurnstileVerifyForTests(seam)

      expect(await verifyTurnstile('', '1.2.3.4')).toEqual({
        ok: false,
        reason: 'failed',
        codes: ['missing-input-response'],
      })
      expect(await verifyTurnstile(undefined)).toMatchObject({ ok: false, reason: 'failed' })
      expect(await verifyTurnstile('x'.repeat(2049))).toMatchObject({ ok: false, reason: 'failed' })
      expect(seam).not.toHaveBeenCalled()
    })

    it('returns ok when Siteverify reports success, forwarding secret/token/ip', async () => {
      process.env.TURNSTILE_SECRET_KEY = SECRET
      const seam = vi
        .fn<(s: string, t: string, ip: string | null) => Promise<{ success: boolean }>>()
        .mockResolvedValue({ success: true })
      __setTurnstileVerifyForTests(seam)

      const result = await verifyTurnstile('good-token', '9.9.9.9')
      expect(result).toEqual({ ok: true })
      expect(seam).toHaveBeenCalledWith(SECRET, 'good-token', '9.9.9.9')
    })

    it('returns failed with the codes when Siteverify rejects the token', async () => {
      process.env.TURNSTILE_SECRET_KEY = SECRET
      __setTurnstileVerifyForTests(async () => ({
        success: false,
        'error-codes': ['timeout-or-duplicate'],
      }))
      const result = await verifyTurnstile('spent-token')
      expect(result).toEqual({ ok: false, reason: 'failed', codes: ['timeout-or-duplicate'] })
    })

    it('returns error (never throws) when the Siteverify call itself throws', async () => {
      process.env.TURNSTILE_SECRET_KEY = SECRET
      __setTurnstileVerifyForTests(async () => {
        throw new Error('network down')
      })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const result = await verifyTurnstile('good-token')
      expect(result).toEqual({ ok: false, reason: 'error' })
      expect(warn).toHaveBeenCalled()
    })
  })
})
