// @vitest-environment node
//
// This file's global default environment is jsdom (see vitest.config.mts),
// but `jose` (used below to build real test tokens, and by src/proxy.ts
// itself) does `instanceof Uint8Array` checks internally that fail under
// jsdom's separate realm — its `Uint8Array` is not the same constructor as
// Node's. Forcing the plain `node` environment for just this file avoids
// that mismatch. See https://vitest.dev/guide/environment.html#test-environment.

import { SignJWT } from 'jose'
import { NextRequest } from 'next/server'
import { describe, expect, it } from 'vitest'

import { payloadJwtKey, proxy } from '@/proxy'
import { STEP_UP_COOKIE_NAME, signStepUpToken } from '@/lib/totp/stepUpToken'

// Exercises src/proxy.ts (Next.js's request interceptor) directly, without a
// live dev server — the same "unit test the logic, not the transport" pattern
// already used for the custom TOTP endpoints (Vitest doesn't run a real
// Next.js HTTP server).
//
// Real Payload sessions use a *numeric* `id` claim (integer/serial primary
// keys via @payloadcms/db-postgres — see src/payload-types.ts's
// `User.id: number`), so these tests deliberately sign tokens with a numeric
// id too, not a string. An earlier version of this suite used a string id,
// which happened to match a bug in proxy.ts (a `typeof id === 'string'`
// check that rejected every real, numeric-id session) without ever catching
// it — matching Payload's actual claim shape here is what makes these tests
// meaningful.

const USER_ID_NUMBER = 918273
const USER_ID = String(USER_ID_NUMBER)

async function signTestPayloadToken(id: number | string | undefined): Promise<string> {
  const secret = process.env.PAYLOAD_SECRET
  if (!secret) {
    throw new Error(
      'PAYLOAD_SECRET must be set to run this test (see .env.example) — proxy.ts ' +
        'verifies the payload-token JWT against it, same as Payload itself.',
    )
  }
  const claims: Record<string, unknown> = { collection: 'users', email: 'x@example.com' }
  if (id !== undefined) claims.id = id

  // Sign with Payload's DERIVED key (sha256(secret) as hex, truncated to 32),
  // via the same payloadJwtKey the proxy verifies with — NOT the raw secret.
  // Real Payload tokens are signed this way. The original helper (and proxy)
  // used the raw secret, so they agreed with each other while disagreeing with
  // every real session — exactly the bug this guards against going forward.
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('2h')
    .sign(payloadJwtKey(secret))
}

function makeRequest(pathname: string, cookies: Record<string, string>): NextRequest {
  const url = `http://localhost:3000${pathname}`
  const cookieHeader = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')
  return new NextRequest(url, {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
  })
}

describe('proxy (src/proxy.ts) — admin route TOTP gate', () => {
  it('lets public admin paths through with no cookies at all', async () => {
    const req = makeRequest('/admin/login', {})
    const res = await proxy(req)
    expect(res.headers.get('location')).toBeNull()
  })

  it('lets requests with no payload-token cookie through unmodified (no session yet)', async () => {
    const req = makeRequest('/admin/collections/users', {})
    const res = await proxy(req)
    expect(res.headers.get('location')).toBeNull()
  })

  it('redirects to /admin/totp-verify for a valid session with no step-up cookie', async () => {
    const token = await signTestPayloadToken(USER_ID_NUMBER)
    const req = makeRequest('/admin/collections/users', { 'payload-token': token })
    const res = await proxy(req)
    const location = res.headers.get('location')
    expect(location).not.toBeNull()
    expect(new URL(location!).pathname).toBe('/admin/totp-verify')
  })

  it('redirects when the step-up cookie belongs to a different user id', async () => {
    const token = await signTestPayloadToken(USER_ID_NUMBER)
    const wrongCookie = signStepUpToken('someone-else')
    const req = makeRequest('/admin/collections/users', {
      'payload-token': token,
      [STEP_UP_COOKIE_NAME]: wrongCookie,
    })
    const res = await proxy(req)
    expect(new URL(res.headers.get('location')!).pathname).toBe('/admin/totp-verify')
  })

  it('lets the request through once both a session and a matching step-up cookie are present', async () => {
    const token = await signTestPayloadToken(USER_ID_NUMBER)
    const stepUpCookie = signStepUpToken(USER_ID)
    const req = makeRequest('/admin/collections/users', {
      'payload-token': token,
      [STEP_UP_COOKIE_NAME]: stepUpCookie,
    })
    const res = await proxy(req)
    expect(res.headers.get('location')).toBeNull()
  })

  it('treats a malformed payload-token as no session (no redirect loop, no crash)', async () => {
    const req = makeRequest('/admin/collections/users', { 'payload-token': 'not-a-real-jwt' })
    const res = await proxy(req)
    expect(res.headers.get('location')).toBeNull()
  })

  it('treats a token forged with the wrong secret as no session', async () => {
    const forged = await new SignJWT({ collection: 'users', email: 'x@example.com', id: USER_ID_NUMBER })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('2h')
      .sign(new TextEncoder().encode('definitely-not-the-real-payload-secret'))
    const req = makeRequest('/admin/collections/users', { 'payload-token': forged })
    const res = await proxy(req)
    expect(res.headers.get('location')).toBeNull()
  })

  it('never gates /admin/logout, even with a valid session and no step-up cookie', async () => {
    const token = await signTestPayloadToken(USER_ID_NUMBER)
    const req = makeRequest('/admin/logout', { 'payload-token': token })
    const res = await proxy(req)
    expect(res.headers.get('location')).toBeNull()
  })
})
