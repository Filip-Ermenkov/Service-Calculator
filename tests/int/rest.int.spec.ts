import { getPayload, Payload } from 'payload'
import { REST_GET } from '@payloadcms/next/routes'
import config from '@/payload.config'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { signStepUpToken } from '@/lib/totp/stepUpToken'

// HTTP-boundary coverage for the public read gate.
//
// tests/int/content.int.spec.ts asserts the access *rule* through the Local
// API. This file goes one layer out: it invokes Payload's **real REST route
// handler** (the same `REST_GET(config)` that src/app/(payload)/api/[...slug]/
// route.ts exports and Next serves at `/api/*`) with hand-built `Request`s, so
// it exercises the actual public HTTP path end to end — query parsing,
// `payload-token` JWT cookie auth, the collection `read` access constraint, and
// JSON serialization — without needing a browser or a running Next server.
//
// This is the test that answers "is `GET /api/services` safe for anonymous
// visitors?" directly, rather than by reasoning about an admin's logged-in
// session (the source of confusion that motivated adding it): hitting the
// endpoint from a logged-in + TOTP-verified admin browser *correctly* returns
// drafts, which can look like a leak until you check it unauthenticated.

const AUTH_COOKIE = 'payload-token'
const STEPUP_COOKIE = 'bulbau-totp-verified'
const PASSWORD = 'a-valid-test-password-123'

/** Invoke the real REST GET handler for a collection, optionally with cookies and a query string. */
async function restGet(
  handler: ReturnType<typeof REST_GET>,
  slug: string[],
  cookie?: string,
  query?: string,
): Promise<{
  status: number
  docs: Array<{ id: number | string; _status?: string; title?: string | null }>
}> {
  const headers = new Headers()
  if (cookie) headers.set('cookie', cookie)
  const url = `http://localhost:3000/api/${slug.join('/')}${query ? `?${query}` : ''}`
  const res = await handler(new Request(url, { headers }), { params: Promise.resolve({ slug }) })
  const body = (await res.json()) as {
    docs?: Array<{ id: number | string; _status?: string; title?: string | null }>
  }
  return { status: res.status, docs: body.docs ?? [] }
}

const idsOf = (docs: Array<{ id: number | string }>) => docs.map((d) => d.id)

describe('Public REST boundary — real route handler (src/app/(payload)/api)', () => {
  let payload: Payload
  let handler: ReturnType<typeof REST_GET>

  let adminId: number | string
  let verifiedCookie: string // password session + completed TOTP step-up
  let passwordOnlyCookie: string // password session, NO step-up (stolen password)

  let publishedServiceId: number | string
  let draftServiceId: number | string
  let activeCareerId: number | string
  let archivedCareerId: number | string

  beforeAll(async () => {
    const payloadConfig = await config
    payload = await getPayload({ config: payloadConfig })
    handler = REST_GET(payloadConfig)

    const admin = await payload.create({
      collection: 'users',
      data: {
        email: `rest-int-admin-${Date.now()}@example.com`,
        password: PASSWORD,
        totpEnabled: true,
      },
    })
    adminId = admin.id

    // A real payload-token JWT, obtained the same way a browser login does.
    const { token } = await payload.login({
      collection: 'users',
      data: { email: admin.email as string, password: PASSWORD },
    })
    const stepUp = signStepUpToken(String(adminId))
    verifiedCookie = `${AUTH_COOKIE}=${token}; ${STEPUP_COOKIE}=${stepUp}`
    passwordOnlyCookie = `${AUTH_COOKIE}=${token}`

    const published = await payload.create({
      collection: 'services',
      data: { title: 'REST published service', _status: 'published' },
    })
    publishedServiceId = published.id
    const draft = await payload.create({
      collection: 'services',
      data: { title: 'REST draft service', _status: 'draft' },
    })
    draftServiceId = draft.id

    const active = await payload.create({
      collection: 'career-listings',
      data: { title: 'REST active role', status: 'active' },
    })
    activeCareerId = active.id
    const archived = await payload.create({
      collection: 'career-listings',
      data: { title: 'REST archived role', status: 'archived' },
    })
    archivedCareerId = archived.id
  })

  afterAll(async () => {
    await payload.delete({ collection: 'services', id: publishedServiceId }).catch(() => undefined)
    await payload.delete({ collection: 'services', id: draftServiceId }).catch(() => undefined)
    await payload.delete({ collection: 'career-listings', id: activeCareerId }).catch(() => undefined)
    await payload.delete({ collection: 'career-listings', id: archivedCareerId }).catch(() => undefined)
    await payload.delete({ collection: 'users', id: adminId }).catch(() => undefined)
  })

  it('GET /api/services (anonymous) returns published, never drafts', async () => {
    const { status, docs } = await restGet(handler, ['services'])
    expect(status).toBe(200)
    expect(idsOf(docs)).toContain(publishedServiceId)
    expect(idsOf(docs)).not.toContain(draftServiceId)
    // Belt-and-braces: nothing draft-statused leaks through, even if other
    // suites seeded their own drafts.
    expect(docs.every((d) => d._status !== 'draft')).toBe(true)
  })

  it('GET /api/career-listings (anonymous) returns active, never archived', async () => {
    const { status, docs } = await restGet(handler, ['career-listings'])
    expect(status).toBe(200)
    expect(idsOf(docs)).toContain(activeCareerId)
    expect(idsOf(docs)).not.toContain(archivedCareerId)
  })

  it('GET /api/services with a verified-admin cookie DOES include drafts', async () => {
    const { status, docs } = await restGet(handler, ['services'], verifiedCookie)
    expect(status).toBe(200)
    expect(idsOf(docs)).toContain(draftServiceId)
  })

  it('GET /api/services with a password-only cookie (no TOTP step-up) hides drafts', async () => {
    // A stolen password, without the second factor, must be treated exactly
    // like the anonymous public — this is the whole point of the 2FA gate.
    const { status, docs } = await restGet(handler, ['services'], passwordOnlyCookie)
    expect(status).toBe(200)
    expect(idsOf(docs)).toContain(publishedServiceId)
    expect(idsOf(docs)).not.toContain(draftServiceId)
  })

  it('serves the EN fallback for an untranslated locale, empty only when fallback is disabled', async () => {
    // The seeded service has an EN title but no FR/DE translation — the admin's
    // common case (fill EN, translate later in Phase 5). The admin editor
    // deliberately shows the raw (empty) DE value so you can see what's actually
    // translated; the public API is where `localization.fallback: true` takes
    // effect, so `?locale=de` still serves the EN title rather than a blank.
    const de = await restGet(handler, ['services'], undefined, 'locale=de')
    const deDoc = de.docs.find((d) => d.id === publishedServiceId)
    expect(deDoc?.title).toBe('REST published service') // EN fallback

    // Proof the DE value is genuinely empty and only the fallback fills it:
    // disabling the fallback returns no DE title for the same document.
    const raw = await restGet(handler, ['services'], undefined, 'locale=de&fallback-locale=none')
    const rawDoc = raw.docs.find((d) => d.id === publishedServiceId)
    expect(rawDoc).toBeDefined()
    expect(rawDoc?.title).toBeFalsy()
  })
})
