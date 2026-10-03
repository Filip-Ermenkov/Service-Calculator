/**
 * @vitest-environment node
 *
 * Runs in the `node` environment rather than the suite-default `jsdom`, for the
 * same reason rest.int.spec.ts does: `payload.login()` below signs a JWT via
 * `jose`, and Vitest's jsdom setup replaces the global `Uint8Array` with
 * jsdom's own copy, so jose's `instanceof Uint8Array` check fails with "payload
 * must be an instance of Uint8Array" before any assertion runs. These are
 * server-side HTTP-API tests with no DOM. See panva/jose#671, vitest-dev/vitest#5183.
 */
import { getPayload, type Payload } from 'payload'
import { REST_POST } from '@payloadcms/next/routes'
import config from '@/payload.config'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { requireTotpVerified } from '@/access/requireTotpVerified'
import { encryptTotpSecret } from '@/lib/totp/crypto'
import { generateTotpSecret } from '@/lib/totp/otp'
import { __resetInMemoryRateLimitForTests } from '@/lib/totp/rateLimit'
import { signStepUpToken } from '@/lib/totp/stepUpToken'

/**
 * POST /api/users/totp/admin-reset — the break-glass path that lets one admin
 * clear another's lost authenticator (src/collections/Users.endpoints.ts).
 *
 * Driven through the REAL route handler (`REST_POST(config)`, the same one
 * src/app/(payload)/api/[...slug] mounts) rather than by calling the handler
 * function directly, so the session parsing, the custom-endpoint routing and
 * the access layer are all genuinely exercised.
 *
 * EVERY rejection case below targets a REAL, EXISTING user on purpose — the
 * same trap rest.int.spec.ts documents for `unlock`. If the target did not
 * exist, a 404 would be indistinguishable from the rejection under test and
 * the test would still pass with the guard removed.
 */

const PASSWORD = 'a-valid-test-password-123'
const AUTH_COOKIE = 'payload-token'
const STEPUP_COOKIE = 'bulbau-totp-verified'
const SAME_ORIGIN = 'http://localhost:3000'

describe('POST /api/users/totp/admin-reset', () => {
  let payload: Payload
  let postHandler: ReturnType<typeof REST_POST>

  let actorId: string | number
  let targetId: string | number
  let verifiedCookie: string // password session + completed TOTP step-up
  let passwordOnlyCookie: string // password session only (a stolen password)

  async function post(body: unknown, cookie?: string) {
    const headers = new Headers({ 'content-type': 'application/json' })
    if (cookie) headers.set('cookie', cookie)
    // Payload copies `serverURL` onto its cookie-CSRF allowlist, and a real
    // browser sends `Origin` on every non-GET request. Without it the cookie is
    // ignored, `req.user` is undefined, and EVERY case here would return 401 —
    // including the ones meant to prove a 403 or a 429. (rest.int.spec.ts does
    // the same thing via its `applyShape` helper.)
    headers.set('origin', SAME_ORIGIN)
    const slug = ['users', 'totp', 'admin-reset']
    const res = await postHandler(
      new Request(`${SAME_ORIGIN}/api/${slug.join('/')}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ slug }) },
    )
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> }
  }

  /** Re-read the target straight from the DB, bypassing access control. */
  async function readTarget() {
    return payload.findByID({ collection: 'users', id: targetId, overrideAccess: true })
  }

  /** Give the target a complete, enrolled-looking 2FA state. */
  async function enrolTarget() {
    await payload.update({
      collection: 'users',
      id: targetId,
      data: {
        totpEnabled: true,
        totpSecret: encryptTotpSecret(generateTotpSecret()),
        totpLastTimeStep: 12345,
      },
      overrideAccess: true,
    })
  }

  beforeAll(async () => {
    const payloadConfig = await config
    payload = await getPayload({ config: payloadConfig })
    postHandler = REST_POST(payloadConfig)

    const stamp = Date.now()
    const actor = await payload.create({
      collection: 'users',
      data: { email: `tfa-actor-${stamp}@example.com`, password: PASSWORD, totpEnabled: true },
    })
    actorId = actor.id

    const target = await payload.create({
      collection: 'users',
      data: { email: `tfa-target-${stamp}@example.com`, password: PASSWORD, totpEnabled: true },
    })
    targetId = target.id

    const { token } = await payload.login({
      collection: 'users',
      data: { email: actor.email as string, password: PASSWORD },
    })
    verifiedCookie = `${AUTH_COOKIE}=${token}; ${STEPUP_COOKIE}=${signStepUpToken(String(actorId))}`
    passwordOnlyCookie = `${AUTH_COOKIE}=${token}`
  })

  beforeEach(async () => {
    // The endpoint budgets 5 attempts per actor AND per IP in a 5-minute
    // window; every case here shares both keys, so without this the later
    // tests would 429 instead of exercising what they name.
    __resetInMemoryRateLimitForTests()
    await enrolTarget()
  })

  afterAll(async () => {
    await payload.delete({ collection: 'users', id: targetId }).catch(() => undefined)
    await payload.delete({ collection: 'users', id: actorId }).catch(() => undefined)
  })

  it('rejects an anonymous caller', async () => {
    const { status } = await post({ userId: targetId, currentPassword: PASSWORD })
    expect(status).toBe(401)
  })

  it('rejects a password-only session with no TOTP step-up — the stolen-password case', async () => {
    const { status } = await post(
      { userId: targetId, currentPassword: PASSWORD },
      passwordOnlyCookie,
    )
    expect(status).toBe(403)
    // And it really did nothing.
    expect((await readTarget()).totpEnabled).toBe(true)
  })

  it('rejects a missing userId', async () => {
    const { status } = await post({ currentPassword: PASSWORD }, verifiedCookie)
    expect(status).toBe(400)
  })

  it('rejects a missing currentPassword', async () => {
    const { status } = await post({ userId: targetId }, verifiedCookie)
    expect(status).toBe(400)
  })

  it('refuses to target your own account (that is what /totp/disable is for)', async () => {
    const { status } = await post({ userId: actorId, currentPassword: PASSWORD }, verifiedCookie)
    expect(status).toBe(400)
  })

  it('rejects the wrong password even from a fully verified admin', async () => {
    const { status } = await post(
      { userId: targetId, currentPassword: 'not-the-password' },
      verifiedCookie,
    )
    expect(status).toBe(401)
    expect((await readTarget()).totpEnabled).toBe(true)
  })

  it('returns 404 for a user that does not exist', async () => {
    const { status } = await post({ userId: 99999999, currentPassword: PASSWORD }, verifiedCookie)
    expect(status).toBe(404)
  })

  it('returns 404 — not 500 — for an id the database cannot even coerce', async () => {
    const { status } = await post(
      { userId: 'definitely-not-an-integer', currentPassword: PASSWORD },
      verifiedCookie,
    )
    expect(status).toBe(404)
  })

  it('clears the target’s 2FA for a fully verified admin with the right password', async () => {
    const { status, json } = await post(
      { userId: targetId, currentPassword: PASSWORD },
      verifiedCookie,
    )
    expect(status).toBe(200)
    expect(json.success).toBe(true)
    expect(json.hadTotp).toBe(true)

    const after = await readTarget()
    expect(after.totpEnabled).toBe(false)
    expect(after.totpSecret ?? null).toBeNull()
    expect(after.totpLastTimeStep ?? null).toBeNull()
  })

  it('is idempotent — a second reset succeeds and reports there was nothing to clear', async () => {
    await post({ userId: targetId, currentPassword: PASSWORD }, verifiedCookie)
    __resetInMemoryRateLimitForTests()
    const { status, json } = await post(
      { userId: targetId, currentPassword: PASSWORD },
      verifiedCookie,
    )
    expect(status).toBe(200)
    expect(json.success).toBe(true)
    expect(json.hadTotp).toBe(false)
  })

  it('leaves the target locked out of everything until they re-enrol, even holding a valid step-up cookie', async () => {
    // The consequence that actually matters: the reset must re-open enrolment
    // WITHOUT granting access. requireTotpVerified denies on `!totpEnabled`
    // regardless of the cookie, so a target who still had a live step-up token
    // from before the reset cannot keep using it.
    await post({ userId: targetId, currentPassword: PASSWORD }, verifiedCookie)
    const after = await readTarget()

    const access = requireTotpVerified(() => true)
    const headers = new Headers({ cookie: `${STEPUP_COOKIE}=${signStepUpToken(String(targetId))}` })
    const args = { req: { user: after, headers } } as unknown as Parameters<
      ReturnType<typeof requireTotpVerified>
    >[0]

    expect(await access(args)).toBe(false)
  })

  it('rate-limits a fully verified admin after repeated attempts', async () => {
    // Wrong password each time so nothing is actually reset; the budget is
    // consumed before the password check, which is the point — a caller who is
    // being throttled learns nothing about the password either.
    const statuses: number[] = []
    for (let i = 0; i < 7; i++) {
      const { status } = await post(
        { userId: targetId, currentPassword: 'wrong-password' },
        verifiedCookie,
      )
      statuses.push(status)
    }
    expect(statuses).toContain(429)
    expect((await readTarget()).totpEnabled).toBe(true)
  })
})
