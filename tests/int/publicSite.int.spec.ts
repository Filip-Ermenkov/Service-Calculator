import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@/payload.config'
import { getServices, mediaProps } from '@/lib/content'
import { lexicalToPlainText } from '@/lib/lexical'
import { buildAlternates, pageMetadata } from '@/lib/seo'

// Phase 2 (public site) coverage. Two parts:
//   1. Pure helpers (no DB) — plain-text extraction, media resolution, and the
//      SEO canonical/hreflang builder.
//   2. The public data layer against a real Postgres — that getServices() (which
//      the Home page uses) applies the SAME published-only access rule as the
//      REST boundary, so a draft service is never exposed to the public site.

// ---- pure helpers (no DB) ---------------------------------------------------

describe('lexicalToPlainText (src/lib/lexical.ts)', () => {
  it('flattens nested text nodes and collapses whitespace', () => {
    const doc = {
      root: {
        children: [
          { children: [{ text: 'Hello' }, { text: ' world' }] },
          { children: [{ text: 'Second   line' }] },
        ],
      },
    }
    expect(lexicalToPlainText(doc)).toBe('Hello world Second line')
  })

  it('returns empty string for non-lexical input', () => {
    expect(lexicalToPlainText(null)).toBe('')
    expect(lexicalToPlainText(undefined)).toBe('')
    expect(lexicalToPlainText({ nope: true })).toBe('')
  })

  it('truncates with an ellipsis at the requested length', () => {
    const doc = { root: { children: [{ children: [{ text: 'a'.repeat(50) }] }] } }
    expect(lexicalToPlainText(doc, 10)).toBe(`${'a'.repeat(10)}…`)
  })
})

describe('mediaProps (src/lib/content.ts)', () => {
  it('returns null for unset or unpopulated (id-only) uploads', () => {
    expect(mediaProps(null)).toBeNull()
    expect(mediaProps(undefined)).toBeNull()
    expect(mediaProps(42)).toBeNull()
    // populated but no url (edge case) → null so the placeholder renders
    expect(mediaProps({ alt: 'x' } as never)).toBeNull()
  })

  it('maps a populated upload to render props', () => {
    expect(
      mediaProps({ url: '/api/media/file/x.jpg', alt: 'A roof', width: 800, height: 600 } as never),
    ).toEqual({ url: '/api/media/file/x.jpg', alt: 'A roof', width: 800, height: 600 })
  })
})

describe('SEO alternates/metadata (src/lib/seo.ts)', () => {
  it('builds canonical + hreflang for a content path', () => {
    const alt = buildAlternates('fr', '/projects')
    expect(alt.canonical).toBe('/fr/projects')
    expect(alt.languages).toMatchObject({
      en: '/en/projects',
      fr: '/fr/projects',
      de: '/de/projects',
      'x-default': '/en/projects',
    })
  })

  it('normalises the home path (no trailing slash)', () => {
    expect(buildAlternates('en', '/').canonical).toBe('/en')
    expect((buildAlternates('de', '/').languages as Record<string, string>)['x-default']).toBe('/en')
  })

  it('pageMetadata wires title/description into OpenGraph + canonical', () => {
    const meta = pageMetadata({ locale: 'de', path: '/about', title: 'Über uns', description: 'x' })
    expect(meta.title).toBe('Über uns')
    expect((meta.alternates?.canonical as string)).toBe('/de/about')
    expect(meta.openGraph).toMatchObject({ title: 'Über uns', locale: 'de', siteName: 'Bulbau' })
  })
})

// ---- public data layer against real Postgres --------------------------------

describe('public data layer hides drafts (src/lib/content.ts)', () => {
  let payload: Payload
  const created: number[] = []

  beforeAll(async () => {
    payload = await getPayload({ config: await config })
    const published = await payload.create({
      collection: 'services',
      data: { title: 'PUBLIC_TEST Published', _status: 'published' },
      overrideAccess: true,
      context: { disableRevalidate: true },
    })
    const draft = await payload.create({
      collection: 'services',
      data: { title: 'PUBLIC_TEST Draft', _status: 'draft' },
      overrideAccess: true,
      context: { disableRevalidate: true },
    })
    created.push(published.id as number, draft.id as number)
  })

  afterAll(async () => {
    for (const id of created) {
      await payload
        .delete({ collection: 'services', id, overrideAccess: true, context: { disableRevalidate: true } })
        .catch(() => {})
    }
  })

  it('getServices() returns published services but not drafts', async () => {
    const titles = (await getServices('en')).map((s) => s.title)
    expect(titles).toContain('PUBLIC_TEST Published')
    expect(titles).not.toContain('PUBLIC_TEST Draft')
  })
})
