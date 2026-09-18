/**
 * @vitest-environment node
 *
 * Runs in the `node` environment rather than the suite-default `jsdom`.
 * `payload.login()` (below) signs a JWT via `jose`, and Vitest's jsdom setup
 * replaces the global `Uint8Array` with jsdom's own copy, which breaks jose's
 * `instanceof Uint8Array` check — it fails with "payload must be an instance of
 * Uint8Array". These are server-side HTTP-API tests with no DOM, so `node` is
 * both the correct environment and the documented fix.
 * See https://github.com/panva/jose/issues/671 and vitest-dev/vitest#5183.
 */
import { getPayload, Payload } from 'payload'
import { REST_GET, REST_POST } from '@payloadcms/next/routes'
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

/**
 * The origin Payload's cookie-CSRF allowlist accepts in this environment
 * (`serverURL` → `csrf`, see src/lib/serverUrl.ts). A browser sends `Origin` on
 * every non-GET request and `Sec-Fetch-Site: same-origin` on same-origin GETs;
 * these helpers send the header a real same-origin browser request would carry,
 * so a cookie is honoured exactly as it is in the admin panel. The CSRF cases
 * further down vary these headers deliberately.
 */
const SAME_ORIGIN = 'http://localhost:3000'

/** Request-shaping knobs for the CSRF cases; the defaults model a same-origin browser. */
interface RequestShape {
  /** `Origin` header value; `null` = omit the header entirely. */
  origin?: string | null
  /** `Sec-Fetch-Site` value (only meaningful when `origin` is null). */
  secFetchSite?: string
}

function applyShape(headers: Headers, shape: RequestShape | undefined): void {
  const origin = shape?.origin === undefined ? SAME_ORIGIN : shape.origin
  if (origin !== null) headers.set('origin', origin)
  if (shape?.secFetchSite) headers.set('sec-fetch-site', shape.secFetchSite)
}

/** Invoke the real REST GET handler for a collection, optionally with cookies and a query string. */
async function restGet(
  handler: ReturnType<typeof REST_GET>,
  slug: string[],
  cookie?: string,
  query?: string,
  shape?: RequestShape,
): Promise<{
  status: number
  docs: Array<{ id: number | string; _status?: string; title?: string | null }>
}> {
  const headers = new Headers()
  if (cookie) headers.set('cookie', cookie)
  applyShape(headers, shape)
  const url = `${SAME_ORIGIN}/api/${slug.join('/')}${query ? `?${query}` : ''}`
  const res = await handler(new Request(url, { headers }), { params: Promise.resolve({ slug }) })
  const body = (await res.json()) as {
    docs?: Array<{ id: number | string; _status?: string; title?: string | null }>
  }
  return { status: res.status, docs: body.docs ?? [] }
}

const idsOf = (docs: Array<{ id: number | string }>) => docs.map((d) => d.id)

/** Same as restGet, for a GLOBAL: the response body is the document itself, not `{ docs }`. */
async function restGetGlobal(
  handler: ReturnType<typeof REST_GET>,
  slug: string,
  cookie?: string,
  query?: string,
  shape?: RequestShape,
): Promise<{ status: number; doc: Record<string, unknown> }> {
  const headers = new Headers()
  if (cookie) headers.set('cookie', cookie)
  applyShape(headers, shape)
  const url = `${SAME_ORIGIN}/api/globals/${slug}${query ? `?${query}` : ''}`
  const res = await handler(new Request(url, { headers }), {
    params: Promise.resolve({ slug: ['globals', ...slug.split('/')] }),
  })
  return { status: res.status, doc: (await res.json()) as Record<string, unknown> }
}

/** Invoke the real REST POST handler (used for the auth `unlock` operation below). */
async function restPost(
  handler: ReturnType<typeof REST_POST>,
  slug: string[],
  body: unknown,
  cookie?: string,
  shape?: RequestShape,
): Promise<{ status: number }> {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (cookie) headers.set('cookie', cookie)
  applyShape(headers, shape)
  const res = await handler(
    new Request(`http://localhost:3000/api/${slug.join('/')}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ slug }) },
  )
  return { status: res.status }
}

describe('Public REST boundary — real route handler (src/app/(payload)/api)', () => {
  let payload: Payload
  let handler: ReturnType<typeof REST_GET>
  let postHandler: ReturnType<typeof REST_POST>

  let adminId: number | string
  let adminEmail: string
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
    postHandler = REST_POST(payloadConfig)

    const admin = await payload.create({
      collection: 'users',
      data: {
        email: `rest-int-admin-${Date.now()}@example.com`,
        password: PASSWORD,
        totpEnabled: true,
      },
    })
    adminId = admin.id
    adminEmail = admin.email as string

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

  // ── Payload's cookie-CSRF allowlist (serverURL → csrf) ────────────────────
  //
  // Until 2026-09-16 the config set neither `serverURL` nor `csrf`, and with an
  // EMPTY `csrf` list Payload accepts the `payload-token` cookie from ANY Origin
  // (verified in payload@3.89 `auth/extractJWT.js`) — its CSRF protection was off.
  // `serverURL` is now resolved per stage (src/lib/serverUrl.ts) and Payload's
  // sanitizer copies it onto `csrf`, so exactly one origin is trusted. These cases
  // hold that in place; delete `serverURL` from the config and the foreign-origin
  // case returns the draft.
  describe('cookie auth honours the CSRF origin allowlist', () => {
    it('ignores a verified-admin cookie sent from a FOREIGN Origin (treated as anonymous)', async () => {
      const { status, docs } = await restGet(handler, ['services'], verifiedCookie, undefined, {
        origin: 'https://evil.example',
      })
      expect(status).toBe(200)
      expect(idsOf(docs)).toContain(publishedServiceId)
      expect(idsOf(docs)).not.toContain(draftServiceId)
    })

    it('accepts the cookie on a same-origin GET that carries no Origin but Sec-Fetch-Site: same-origin (how browsers send them)', async () => {
      const { status, docs } = await restGet(handler, ['services'], verifiedCookie, undefined, {
        origin: null,
        secFetchSite: 'same-origin',
      })
      expect(status).toBe(200)
      expect(idsOf(docs)).toContain(draftServiceId)
    })

    it('ignores the cookie when neither Origin nor Sec-Fetch-Site is present (a non-browser client)', async () => {
      const { docs } = await restGet(handler, ['services'], verifiedCookie, undefined, {
        origin: null,
      })
      expect(idsOf(docs)).not.toContain(draftServiceId)
    })

    it('refuses the unlock operation for a fully verified session replayed from a foreign Origin', async () => {
      const { status } = await restPost(
        postHandler,
        ['users', 'unlock'],
        { email: adminEmail },
        verifiedCookie,
        { origin: 'https://evil.example' },
      )
      expect(status).toBe(403)
    })
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

  // ── GET /api/globals/legal-info?draft=true — the §6.9 draft must never leak ──
  //
  // LegalInfo's `read` used to be `() => true`, on the reasoning that a plain
  // read only ever returns the published main row. `?draft=true` broke that:
  // Payload then swaps in the newest version from the versions table and, with
  // a boolean-true access result, filters that version query by NOTHING
  // (payload@3.89 `versions/drafts/replaceWithDraftIfAvailable.js`) — so the
  // unpublished draft, i.e. exactly the placeholder registration details §6.9
  // says must never be public, came back to an anonymous caller. Reproduced
  // against this very handler on 2026-09-18. Payload's docs are explicit that
  // `draft` restricts nothing and `_status`-based read access must; the global
  // now uses the same `readPublishedOrVerified` rule as the collections.
  //
  // The MARKER is a value that only ever exists in the draft, so "not leaked"
  // is asserted on content, never on `_status` alone (a published row that
  // happens to carry the same fields would otherwise mask a regression).
  describe('GET /api/globals/legal-info?draft=true never exposes the unpublished draft', () => {
    const MARKER = `REST-LEGAL-DRAFT-MARKER-${Date.now()}`

    beforeAll(async () => {
      // A draft that differs from whatever is published (content.int.spec.ts
      // publishes a complete LegalInfo earlier in the run; on a fresh DB nothing
      // is published at all — both states must hold).
      await payload.updateGlobal({
        slug: 'legal-info',
        draft: true,
        data: { legalName: MARKER, rcsNumber: MARKER },
        context: { disableRevalidate: true },
      })
    })

    it('anonymous: the draft is NOT returned, with or without ?draft=true', async () => {
      const plain = await restGetGlobal(handler, 'legal-info')
      expect(plain.status).toBe(200)
      expect(JSON.stringify(plain.doc)).not.toContain(MARKER)
      expect(plain.doc._status === undefined || plain.doc._status === 'published').toBe(true)

      const draft = await restGetGlobal(handler, 'legal-info', undefined, 'draft=true')
      expect(draft.status).toBe(200)
      expect(JSON.stringify(draft.doc)).not.toContain(MARKER)
      expect(draft.doc._status).not.toBe('draft')
    })

    it('password-only session (no TOTP step-up): treated like the public, draft hidden', async () => {
      const { doc } = await restGetGlobal(handler, 'legal-info', passwordOnlyCookie, 'draft=true')
      expect(JSON.stringify(doc)).not.toContain(MARKER)
      expect(doc._status).not.toBe('draft')
    })

    it('fully verified admin: the draft IS returned (the editor needs it)', async () => {
      const { status, doc } = await restGetGlobal(handler, 'legal-info', verifiedCookie, 'draft=true')
      expect(status).toBe(200)
      expect(doc.legalName).toBe(MARKER)
      expect(doc._status).toBe('draft')
    })

    it('the public data layer (src/lib/content.ts) sees the same thing as anonymous REST', async () => {
      // `getLegalInfo` reads with overrideAccess:false and no `draft`, but the
      // rule must hold for a draft read too — this is the Local-API twin of the
      // anonymous REST case, so a future caller cannot reopen the hole.
      const asPublic = await payload.findGlobal({
        slug: 'legal-info',
        overrideAccess: false,
        draft: true,
      })
      expect(JSON.stringify(asPublic)).not.toContain(MARKER)
    })
  })

  // ── /versions — every saved version, drafts included, behind the 2FA step ──
  //
  // Neither collection nor global ever set `access.readVersions`, and Payload's
  // fallback for an UNSET access function is `Boolean(req.user)` (verified in
  // payload@3.89 `auth/executeAccess.js`). So `GET /api/services/versions` and
  // `GET /api/globals/legal-info/versions` handed every draft to a session that
  // had only passed the PASSWORD step — the same class of gap as `users.unlock`.
  // The read/create/update/delete boundary ("a password-only session sees
  // nothing extra") now holds for versions too.
  describe('versions endpoints require the completed TOTP step-up', () => {
    it('GET /api/services/versions: anonymous and password-only are refused, verified admin sees the draft', async () => {
      const anon = await restGet(handler, ['services', 'versions'])
      expect(anon.status).toBe(403)

      const passwordOnly = await restGet(handler, ['services', 'versions'], passwordOnlyCookie)
      expect(passwordOnly.status).toBe(403)

      const verified = await restGet(handler, ['services', 'versions'], verifiedCookie)
      expect(verified.status).toBe(200)
      const parents = (verified.docs as unknown as Array<{ parent: number | string }>).map((v) => v.parent)
      expect(parents).toContain(draftServiceId)
    })

    it('GET /api/globals/legal-info/versions: anonymous and password-only are refused, verified admin is allowed', async () => {
      const anon = await restGetGlobal(handler, 'legal-info/versions')
      expect(anon.status).toBe(403)

      const passwordOnly = await restGetGlobal(handler, 'legal-info/versions', passwordOnlyCookie)
      expect(passwordOnly.status).toBe(403)

      const verified = await restGetGlobal(handler, 'legal-info/versions', verifiedCookie)
      expect(verified.status).toBe(200)
      expect(Array.isArray(verified.doc.docs)).toBe(true)
    })
  })

  // ── GraphQL is switched off ────────────────────────────────────────────────
  // Nothing in this app uses it (Local API on the public site, REST + server
  // functions in the admin), yet Payload mounted an unauthenticated,
  // introspectable `POST /api/graphql` on every stage. `graphQL.disable: true`
  // in payload.config.ts plus the deleted route files make it a plain 404 —
  // this drives the REST catch-all the path now falls through to.
  it('POST /api/graphql is not a route any more (GraphQL disabled)', async () => {
    const { status } = await restPost(postHandler, ['graphql'], { query: '{ __typename }' })
    expect(status).toBe(404)
  })

  // ── POST /api/users/unlock — the FIFTH access operation ───────────────────
  //
  // `unlock` clears the login lockout that Users.auth.maxLoginAttempts (5) and
  // lockTime (10 min) impose — i.e. it resets the first-factor brute-force
  // defence. Until 2026-09 it was the one operation on the Users collection NOT
  // wrapped in requireTotpVerified, so it silently used Payload's
  // `defaultAccess` (`Boolean(user)`): a session holding only a stolen PASSWORD,
  // with no TOTP step-up, could clear the lockout.
  //
  // This is NOT covered by the payload 3.89.0 bump. GHSA-jg8r-5jh2-v2xj lists no
  // patched version, and 3.89.0's defaults still use `unlock: defaultAccess` —
  // upgrading only moves the app outside the advisory's `<=3.88.0` range, which
  // is why `npm audit` stops reporting it. The rule in src/collections/Users.ts
  // is the real fix, and these cases are what hold it in place.
  //
  // EVERY case below targets a REAL, EXISTING account on purpose. The operation
  // throws `Forbidden` (403) when it cannot find the named user, so a made-up
  // address produces a 403 that looks exactly like an access denial while
  // proving nothing — the first draft of these tests passed even with the
  // access rule removed for precisely that reason.
  describe('POST /api/users/unlock is TOTP-gated like every other Users operation', () => {
    it('rejects an anonymous caller', async () => {
      const { status } = await restPost(postHandler, ['users', 'unlock'], { email: adminEmail })
      expect(status).toBe(403)
    })

    it('rejects a password-only session (no TOTP step-up) — the regression case', async () => {
      const { status } = await restPost(
        postHandler,
        ['users', 'unlock'],
        { email: adminEmail },
        passwordOnlyCookie,
      )
      expect(status).toBe(403)
    })

    it('allows a fully verified admin (password + completed TOTP step-up)', async () => {
      const { status } = await restPost(
        postHandler,
        ['users', 'unlock'],
        { email: adminEmail },
        verifiedCookie,
      )
      expect(status).toBe(200)
    })
  })

  // ── POST /api/users/logout — expires the 2FA step-up cookie too ───────────
  //
  // Payload's logout only expires its own `payload-token`. The step-up cookie is
  // an independent token, and until 2026-09-13 it survived logout: log out, log
  // back in with just the password on the same browser within the ~2h TTL, and
  // the TOTP prompt was skipped once. `clearStepUpCookieAfterLogout`
  // (src/collections/Users.ts) closes that through Payload's `afterLogout` hook +
  // `req.responseHeaders`, which the endpoint router merges into the response.
  // This drives the REAL logout route handler and inspects the Set-Cookie headers
  // it actually emits — the only place the fix is observable.
  describe('POST /api/users/logout also expires the step-up cookie', () => {
    it('emits an expired bulbau-totp-verified cookie alongside the expired payload-token', async () => {
      // A fresh session of its own, so logging it out cannot disturb the shared
      // verifiedCookie the other cases rely on.
      const { token } = await payload.login({
        collection: 'users',
        data: { email: adminEmail, password: PASSWORD },
      })
      const cookie = `${AUTH_COOKIE}=${token}; ${STEPUP_COOKIE}=${signStepUpToken(String(adminId))}`

      const headers = new Headers({ 'content-type': 'application/json', cookie, origin: SAME_ORIGIN })
      const res = await postHandler(
        new Request(`${SAME_ORIGIN}/api/users/logout`, { method: 'POST', headers }),
        { params: Promise.resolve({ slug: ['users', 'logout'] }) },
      )
      expect(res.status).toBe(200)

      const setCookies = res.headers.getSetCookie()
      const payloadCookie = setCookies.find((c) => c.startsWith(`${AUTH_COOKIE}=`))
      const stepUpCookie = setCookies.find((c) => c.startsWith(`${STEPUP_COOKIE}=`))

      // Payload's own behaviour is unchanged…
      expect(payloadCookie).toBeDefined()
      // …and ours rides the same response: an EMPTY value with Max-Age=0 (i.e.
      // "delete this cookie"), HttpOnly, on the same Path the live cookie uses.
      expect(stepUpCookie).toBeDefined()
      expect(stepUpCookie).toMatch(new RegExp(`^${STEPUP_COOKIE}=;`))
      expect(stepUpCookie).toMatch(/Max-Age=0/)
      expect(stepUpCookie).toMatch(/HttpOnly/)
      expect(stepUpCookie).toMatch(/Path=\//)
    })
  })
})
