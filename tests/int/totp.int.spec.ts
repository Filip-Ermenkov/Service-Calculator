import { getPayload, Payload } from 'payload'
import config from '@/payload.config'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { requireTotpVerified } from '@/access/requireTotpVerified'
import { decryptTotpSecret, encryptTotpSecret } from '@/lib/totp/crypto'
import { generateTotpSecret, generateTotpToken, verifyTotpToken } from '@/lib/totp/otp'
import {
  __resetInMemoryRateLimitForTests,
  checkTotpRateLimit,
} from '@/lib/totp/rateLimit'
import { signStepUpToken } from '@/lib/totp/stepUpToken'

describe('TOTP secret encryption (src/lib/totp/crypto.ts)', () => {
  it('round-trips a secret through encrypt/decrypt', () => {
    const secret = generateTotpSecret()
    const encrypted = encryptTotpSecret(secret)
    expect(encrypted).not.toBe(secret)
    expect(decryptTotpSecret(encrypted)).toBe(secret)
  })

  it('produces a different ciphertext each time (random IV) for the same plaintext', () => {
    const secret = generateTotpSecret()
    const a = encryptTotpSecret(secret)
    const b = encryptTotpSecret(secret)
    expect(a).not.toBe(b)
    expect(decryptTotpSecret(a)).toBe(secret)
    expect(decryptTotpSecret(b)).toBe(secret)
  })

  it('rejects a tampered ciphertext (GCM auth tag)', () => {
    const secret = generateTotpSecret()
    const encrypted = encryptTotpSecret(secret)
    const [iv, authTag, ciphertext] = encrypted.split(':')
    // Flip the last ciphertext byte
    const tamperedBuf = Buffer.from(ciphertext!, 'base64')
    tamperedBuf[tamperedBuf.length - 1] = (tamperedBuf[tamperedBuf.length - 1]! ^ 0xff) & 0xff
    const tampered = [iv, authTag, tamperedBuf.toString('base64')].join(':')

    expect(() => decryptTotpSecret(tampered)).toThrow()
  })
})

describe('TOTP verification (src/lib/totp/otp.ts)', () => {
  it('accepts the current valid code', async () => {
    const secret = generateTotpSecret()
    const token = await generateTotpToken(secret)
    const result = await verifyTotpToken({ secret, token })
    expect(result.valid).toBe(true)
  })

  it('rejects an incorrect code', async () => {
    const secret = generateTotpSecret()
    const result = await verifyTotpToken({ secret, token: '000000' })
    expect(result.valid).toBe(false)
  })

  it('rejects malformed input rather than throwing', async () => {
    const secret = generateTotpSecret()
    const result = await verifyTotpToken({ secret, token: 'not-a-code' })
    expect(result.valid).toBe(false)
  })

  it('replay protection: the same code cannot be verified twice via afterTimeStep', async () => {
    const secret = generateTotpSecret()
    const token = await generateTotpToken(secret)

    const first = await verifyTotpToken({ secret, token })
    expect(first.valid).toBe(true)
    if (!first.valid) throw new Error('unreachable')

    const replay = await verifyTotpToken({ secret, token, afterTimeStep: first.timeStep })
    expect(replay.valid).toBe(false)
  })
})

describe('TOTP rate limiting — in-memory fallback (src/lib/totp/rateLimit.ts)', () => {
  // These tests rely on UPSTASH_REDIS_REST_URL/TOKEN being unset in this
  // environment (true for local dev and CI per .env.example / ci.yml), so
  // checkTotpRateLimit exercises the in-memory limiter, not real Upstash.
  beforeAll(() => {
    expect(process.env.UPSTASH_REDIS_REST_URL).toBeUndefined()
  })

  it('allows attempts under the limit and blocks once exceeded', async () => {
    const key = `test-key-${Math.random()}`
    __resetInMemoryRateLimitForTests()

    for (let i = 0; i < 5; i++) {
      const result = await checkTotpRateLimit(key)
      expect(result.success).toBe(true)
    }

    const blocked = await checkTotpRateLimit(key)
    expect(blocked.success).toBe(false)
  })

  it('tracks separate keys independently', async () => {
    __resetInMemoryRateLimitForTests()
    const keyA = 'independent-a'
    const keyB = 'independent-b'

    for (let i = 0; i < 5; i++) {
      expect((await checkTotpRateLimit(keyA)).success).toBe(true)
    }
    expect((await checkTotpRateLimit(keyA)).success).toBe(false)
    // keyB has its own budget, untouched by keyA's attempts
    expect((await checkTotpRateLimit(keyB)).success).toBe(true)
  })
})

describe('requireTotpVerified access wrapper (src/access/requireTotpVerified.ts)', () => {
  const baseAccessAllow = () => true

  function makeArgs(user: unknown, headers: Headers) {
    return { req: { user, headers } } as unknown as Parameters<
      ReturnType<typeof requireTotpVerified>
    >[0]
  }

  it('denies when there is no logged-in user', async () => {
    const access = requireTotpVerified(baseAccessAllow)
    const result = await access(makeArgs(null, new Headers()))
    expect(result).toBe(false)
  })

  it('denies a logged-in user who has not enrolled in 2FA yet', async () => {
    const access = requireTotpVerified(baseAccessAllow)
    const result = await access(makeArgs({ id: 'user-1', totpEnabled: false }, new Headers()))
    expect(result).toBe(false)
  })

  it('denies an enrolled user with no step-up cookie', async () => {
    const access = requireTotpVerified(baseAccessAllow)
    const result = await access(makeArgs({ id: 'user-1', totpEnabled: true }, new Headers()))
    expect(result).toBe(false)
  })

  it('denies an enrolled user whose step-up cookie belongs to a different user id', async () => {
    const access = requireTotpVerified(baseAccessAllow)
    const cookieForSomeoneElse = signStepUpToken('a-different-user-id')
    const headers = new Headers({ cookie: `bulbau-totp-verified=${cookieForSomeoneElse}` })
    const result = await access(makeArgs({ id: 'user-1', totpEnabled: true }, headers))
    expect(result).toBe(false)
  })

  it('delegates to the wrapped access function once both factors check out', async () => {
    const access = requireTotpVerified(baseAccessAllow)
    const validCookie = signStepUpToken('user-1')
    const headers = new Headers({ cookie: `bulbau-totp-verified=${validCookie}` })
    const result = await access(makeArgs({ id: 'user-1', totpEnabled: true }, headers))
    expect(result).toBe(true)
  })

  it("still respects the wrapped access function's own decision", async () => {
    const access = requireTotpVerified(() => false)
    const validCookie = signStepUpToken('user-1')
    const headers = new Headers({ cookie: `bulbau-totp-verified=${validCookie}` })
    const result = await access(makeArgs({ id: 'user-1', totpEnabled: true }, headers))
    expect(result).toBe(false)
  })
})

describe('totpSecret field is never exposed through the data layer', () => {
  let payload: Payload
  let userId: string | number

  beforeAll(async () => {
    const payloadConfig = await config
    payload = await getPayload({ config: payloadConfig })

    const secret = generateTotpSecret()
    const created = await payload.create({
      collection: 'users',
      data: {
        email: `totp-field-test-${Date.now()}@example.com`,
        password: 'irrelevant-password-not-checked-here',
        totpEnabled: true,
        totpSecret: encryptTotpSecret(secret),
      },
    })
    userId = created.id
  })

  afterAll(async () => {
    if (userId) {
      await payload.delete({ collection: 'users', id: userId }).catch(() => undefined)
    }
  })

  it('IS visible to trusted server code (Local API default: overrideAccess true)', async () => {
    // Local API defaults to overrideAccess: true for exactly this reason —
    // our own endpoint handlers (Users.endpoints.ts) need to read/write this
    // field, and they do so via the Local API without passing
    // overrideAccess explicitly. This is the trusted-server-code path, not
    // a leak: it's never reachable from outside the server process.
    const doc = await payload.findByID({ collection: 'users', id: userId })
    expect((doc as unknown as { totpSecret?: unknown }).totpSecret).toBeDefined()
  })

  it('is stripped from an access-controlled read (overrideAccess: false) — the REST/GraphQL/admin-UI path', async () => {
    // This is the scenario that actually matters: any request that goes
    // through real access control (REST, GraphQL, the admin UI's own
    // document fetches) has overrideAccess effectively false, and this
    // confirms the field's own access.read: () => false hides it even for
    // a user who otherwise fully passes both collection-level factors
    // (logged in + step-up verified).
    const stepUpCookie = signStepUpToken(String(userId))
    const doc = await payload.findByID({
      collection: 'users',
      id: userId,
      overrideAccess: false,
      user: { id: userId, collection: 'users', totpEnabled: true } as never,
      req: { headers: new Headers({ cookie: `bulbau-totp-verified=${stepUpCookie}` }) } as never,
    })
    expect((doc as unknown as { totpSecret?: unknown }).totpSecret).toBeUndefined()
  })
})
