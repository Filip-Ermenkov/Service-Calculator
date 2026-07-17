import { getPayload, Payload } from 'payload'
import config from '@/payload.config'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { signStepUpToken } from '@/lib/totp/stepUpToken'
import {
  findMissingLegalFields,
  REQUIRED_LEGAL_FIELDS,
} from '@/globals/LegalInfo'

// End-to-end coverage for the Phase 1 content model (Services / Projects /
// CareerListings collections + CompanyInfo / LegalInfo globals), exercised
// through Payload's Local API against a real Postgres. Verifies the things
// that are custom logic rather than plain field declarations:
//   1. native EN/FR/DE localization + fallback,
//   2. the draft/active public-read gate (drafts/archived hidden from the
//      public AND from password-only sessions, visible to a fully-2FA-verified
//      admin),
//   3. the LegalInfo publish gate (§6.9 — never publish with placeholder
//      registration details).
//
// NOTE ON SCOPE: these assert the access *rule* through the Local API (the
// same layer the REST/GraphQL APIs run through), which is why an unauthenticated
// `GET /api/services` returns only published docs. They do NOT drive the HTTP
// endpoint itself with real cookies — an end-to-end Playwright check of the
// public REST boundary is a complementary test (see tests/e2e).

// ---- pure logic (no DB) -----------------------------------------------------

describe('LegalInfo publish gate — pure check (src/globals/LegalInfo.ts)', () => {
  it('reports every required field missing when data is empty', () => {
    expect(findMissingLegalFields({})).toEqual([...REQUIRED_LEGAL_FIELDS])
    expect(findMissingLegalFields(null)).toEqual([...REQUIRED_LEGAL_FIELDS])
  })

  it('treats blank / whitespace-only values as missing', () => {
    const missing = findMissingLegalFields({
      legalName: '  ',
      legalForm: '',
      registeredAddress: 'A real address',
      rcsNumber: 'B123456',
      vatNumber: 'LU12345678',
    })
    expect(missing).toEqual(['legalName', 'legalForm'])
  })

  it('reports nothing missing when all identity fields are present', () => {
    expect(
      findMissingLegalFields({
        legalName: 'Bulbau S.à r.l.',
        legalForm: 'S.à r.l.',
        registeredAddress: '1 Rue de la Gare, Luxembourg',
        rcsNumber: 'B123456',
        vatNumber: 'LU12345678',
      }),
    ).toEqual([])
  })
})

// ---- Local API against real Postgres ---------------------------------------

const COOKIE = 'bulbau-totp-verified'

describe('Phase 1 content model (Local API, real Postgres)', () => {
  let payload: Payload
  let adminUserId: string | number
  const createdServiceIds: (string | number)[] = []
  const createdCareerIds: (string | number)[] = []

  // Simulate a request from a fully 2FA-verified admin (password session +
  // valid step-up cookie for their own id) — this is what should see drafts.
  const asVerifiedAdmin = () => ({
    overrideAccess: false as const,
    user: { id: adminUserId, collection: 'users', totpEnabled: true } as never,
    req: {
      headers: new Headers({
        cookie: `${COOKIE}=${signStepUpToken(String(adminUserId))}`,
      }),
    } as never,
  })

  // Simulate an anonymous public request (the public site).
  const asPublic = () => ({ overrideAccess: false as const })

  // Simulate a session that passed the password (first factor) but has NOT
  // completed the TOTP step-up. This is the security-critical case: a stolen
  // password, without the 2FA device, must be treated exactly like the
  // anonymous public — published content only, no drafts.
  const asPasswordOnly = () => ({
    overrideAccess: false as const,
    user: { id: adminUserId, collection: 'users', totpEnabled: true } as never,
    req: { headers: new Headers() } as never,
  })

  beforeAll(async () => {
    const payloadConfig = await config
    payload = await getPayload({ config: payloadConfig })

    const admin = await payload.create({
      collection: 'users',
      data: {
        email: `content-int-admin-${Date.now()}@example.com`,
        password: 'irrelevant-password-not-checked-here',
        totpEnabled: true,
      },
    })
    adminUserId = admin.id
  })

  afterAll(async () => {
    for (const id of createdServiceIds) {
      await payload.delete({ collection: 'services', id }).catch(() => undefined)
    }
    for (const id of createdCareerIds) {
      await payload
        .delete({ collection: 'career-listings', id })
        .catch(() => undefined)
    }
    if (adminUserId) {
      await payload
        .delete({ collection: 'users', id: adminUserId })
        .catch(() => undefined)
    }
  })

  it('stores localized fields per-locale and falls back to EN', async () => {
    const svc = await payload.create({
      collection: 'services',
      locale: 'en',
      data: { title: 'Solar panels', _status: 'published' },
    })
    createdServiceIds.push(svc.id)

    await payload.update({
      collection: 'services',
      id: svc.id,
      locale: 'fr',
      data: { title: 'Panneaux solaires' },
    })

    const en = await payload.findByID({ collection: 'services', id: svc.id, locale: 'en' })
    const fr = await payload.findByID({ collection: 'services', id: svc.id, locale: 'fr' })
    // DE was never set → with fallback:true it resolves to the EN source.
    const de = await payload.findByID({ collection: 'services', id: svc.id, locale: 'de' })

    expect(en.title).toBe('Solar panels')
    expect(fr.title).toBe('Panneaux solaires')
    expect(de.title).toBe('Solar panels')
  })

  it('hides draft services from the public but shows them to a verified admin', async () => {
    const draft = await payload.create({
      collection: 'services',
      data: { title: 'Unpublished service', _status: 'draft' },
    })
    createdServiceIds.push(draft.id)

    // Public: draft must not be returned.
    const publicList = await payload.find({
      collection: 'services',
      ...asPublic(),
      pagination: false,
    })
    expect(publicList.docs.some((d) => d.id === draft.id)).toBe(false)

    // Verified admin: draft IS returned.
    const adminList = await payload.find({
      collection: 'services',
      ...asVerifiedAdmin(),
      pagination: false,
    })
    expect(adminList.docs.some((d) => d.id === draft.id)).toBe(true)

    // Password-only session (logged in, but no completed TOTP step-up) must
    // NOT see the draft — it is treated exactly like the anonymous public.
    const passwordOnlyList = await payload.find({
      collection: 'services',
      ...asPasswordOnly(),
      pagination: false,
    })
    expect(passwordOnlyList.docs.some((d) => d.id === draft.id)).toBe(false)

    // Publish it → now visible to the public too.
    await payload.update({
      collection: 'services',
      id: draft.id,
      data: { _status: 'published' },
    })
    const afterPublish = await payload.find({
      collection: 'services',
      ...asPublic(),
      pagination: false,
    })
    expect(afterPublish.docs.some((d) => d.id === draft.id)).toBe(true)
  })

  it('hides archived career listings from the public, shows active ones', async () => {
    const active = await payload.create({
      collection: 'career-listings',
      data: { title: 'Open role', status: 'active' },
    })
    const archived = await payload.create({
      collection: 'career-listings',
      data: { title: 'Filled role', status: 'archived' },
    })
    createdCareerIds.push(active.id, archived.id)

    const publicList = await payload.find({
      collection: 'career-listings',
      ...asPublic(),
      pagination: false,
    })
    const publicIds = publicList.docs.map((d) => d.id)
    expect(publicIds).toContain(active.id)
    expect(publicIds).not.toContain(archived.id)

    // Admin sees archived listings too (so they can be restored).
    const adminList = await payload.find({
      collection: 'career-listings',
      ...asVerifiedAdmin(),
      pagination: false,
    })
    expect(adminList.docs.map((d) => d.id)).toContain(archived.id)
  })

  it('exposes CompanyInfo to the public (contact details are public)', async () => {
    await payload.updateGlobal({
      slug: 'company-info',
      data: { email: 'hello@bulbau.lu' },
    })
    const info = await payload.findGlobal({ slug: 'company-info', ...asPublic() })
    expect(info.email).toBe('hello@bulbau.lu')
  })

  it('enforces the LegalInfo publish gate but allows incomplete drafts', async () => {
    // Publishing with blank identity fields must be rejected (§6.9). The other
    // fields are passed EXPLICITLY blank rather than merely omitted: LegalInfo is
    // a singleton global and `updateGlobal` MERGES with whatever is already
    // stored, so on a dev DB where the global was previously populated (e.g. by
    // manual admin testing) an omitted field would inherit the stored value and
    // the gate would — correctly — let the publish through. Passing them blank
    // makes this assert exactly "publishing while required fields are empty is
    // blocked", deterministically and independent of pre-existing state.
    await expect(
      payload.updateGlobal({
        slug: 'legal-info',
        data: {
          _status: 'published',
          legalName: 'Bulbau (only)',
          legalForm: '',
          registeredAddress: '',
          rcsNumber: '',
          vatNumber: '',
        },
      }),
    ).rejects.toThrow(/Cannot publish the Legal Notice/)

    // But holding an incomplete Legal Notice as a DRAFT is allowed.
    const draft = await payload.updateGlobal({
      slug: 'legal-info',
      draft: true,
      data: { legalName: 'Bulbau (draft only)' },
    })
    expect(draft._status).not.toBe('published')

    // With every identity field present, publishing succeeds.
    const published = await payload.updateGlobal({
      slug: 'legal-info',
      data: {
        _status: 'published',
        legalName: 'Bulbau S.à r.l.',
        legalForm: 'S.à r.l.',
        registeredAddress: '1 Rue de la Gare, L-1611 Luxembourg',
        rcsNumber: 'B123456',
        vatNumber: 'LU12345678',
      },
    })
    expect(published._status).toBe('published')

    const publicView = await payload.findGlobal({ slug: 'legal-info', ...asPublic() })
    expect(publicView.legalName).toBe('Bulbau S.à r.l.')
  })
})
