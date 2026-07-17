import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@/payload.config'
import { getProjects, getServiceBySlug, getServices, mediaProps } from '@/lib/content'
import { lexicalToPlainText } from '@/lib/lexical'
import { filterProjects, projectCategories, type ProjectCard } from '@/lib/projects'
import { buildAlternates, pageMetadata } from '@/lib/seo'
import { formatSlug } from '@/lib/slug'

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

describe('formatSlug (src/lib/slug.ts)', () => {
  it('lowercases, hyphenates and trims', () => {
    expect(formatSlug('Solar Panels')).toBe('solar-panels')
    expect(formatSlug('  Heat  Pumps  ')).toBe('heat-pumps')
    expect(formatSlug('Electrical / Wiring & More')).toBe('electrical-wiring-more')
  })

  it('folds accents (FR/DE friendly)', () => {
    expect(formatSlug('Réalisations')).toBe('realisations')
    expect(formatSlug('Wärmepumpe')).toBe('warmepumpe')
  })

  it('collapses non-alphanumeric runs and strips edge hyphens', () => {
    expect(formatSlug('--A___B..C--')).toBe('a-b-c')
    expect(formatSlug('123 Go!')).toBe('123-go')
  })
})

describe('filterProjects / projectCategories (src/lib/projects.ts)', () => {
  const items: ProjectCard[] = [
    { id: 1, title: 'Rooftop Array', blurb: 'A large solar install', dateLabel: '', imageUrl: null, imageAlt: '', category: 'Solar' },
    { id: 2, title: 'Office Rewire', blurb: 'Full electrical refit', dateLabel: '', imageUrl: null, imageAlt: '', category: 'Electrical' },
    { id: 3, title: 'Barn Panels', blurb: 'Off-grid solar', dateLabel: '', imageUrl: null, imageAlt: '', category: 'Solar' },
    { id: 4, title: 'Legacy Job', blurb: 'From a removed service', dateLabel: '', imageUrl: null, imageAlt: '', category: 'Retired Service' },
  ]

  it('returns everything for empty query + empty category', () => {
    expect(filterProjects(items, '', '')).toHaveLength(4)
  })

  it('matches the query against title OR blurb, case-insensitively', () => {
    expect(filterProjects(items, 'solar', '').map((p) => p.id)).toEqual([1, 3])
    expect(filterProjects(items, 'REWIRE', '').map((p) => p.id)).toEqual([2])
  })

  it('filters by exact category and combines with the query (AND)', () => {
    expect(filterProjects(items, '', 'Solar').map((p) => p.id)).toEqual([1, 3])
    expect(filterProjects(items, 'barn', 'Solar').map((p) => p.id)).toEqual([3])
  })

  it('lists distinct non-empty categories, sorted — incl. a retained/deleted-service label (§7)', () => {
    expect(projectCategories(items)).toEqual(['Electrical', 'Retired Service', 'Solar'])
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

describe('service slug + project service-name snapshot (Phase 2b, real Postgres)', () => {
  let payload: Payload
  // Unique per run so the slug's unique index never collides with a prior run.
  const tag = `snap-${Date.now()}`
  let serviceId: number
  let projectId: number

  beforeAll(async () => {
    payload = await getPayload({ config: await config })
    const svc = await payload.create({
      collection: 'services',
      data: { title: `Solar ${tag}`, _status: 'published' },
      overrideAccess: true,
      context: { disableRevalidate: true },
    })
    serviceId = svc.id as number

    const proj = await payload.create({
      collection: 'projects',
      data: {
        title: `Rooftop ${tag}`,
        completionDate: new Date().toISOString(),
        service: serviceId,
        _status: 'published',
      },
      overrideAccess: true,
      context: { disableRevalidate: true },
    })
    projectId = proj.id as number
  })

  afterAll(async () => {
    await payload
      .delete({ collection: 'projects', id: projectId, overrideAccess: true, context: { disableRevalidate: true } })
      .catch(() => {})
    // serviceId may already be gone (the retain-on-delete test deletes it).
    await payload
      .delete({ collection: 'services', id: serviceId, overrideAccess: true, context: { disableRevalidate: true } })
      .catch(() => {})
  })

  it('auto-generates a slug from the title, resolvable via getServiceBySlug()', async () => {
    const svc = await payload.findByID({ collection: 'services', id: serviceId, overrideAccess: true })
    expect(svc.slug).toBe(formatSlug(`Solar ${tag}`))

    const bySlug = await getServiceBySlug(svc.slug as string, 'en')
    expect(bySlug?.id).toBe(serviceId)
  })

  it('snapshots the service label onto the project (serviceName)', async () => {
    const proj = await payload.findByID({ collection: 'projects', id: projectId, overrideAccess: true })
    expect(proj.serviceName).toBe(`Solar ${tag}`)
  })

  it('RETAINS the snapshot label after the linked service is deleted (§7)', async () => {
    await payload.delete({ collection: 'services', id: serviceId, overrideAccess: true, context: { disableRevalidate: true } })

    // The project still surfaces publicly, and its category label survives even
    // though the relationship no longer resolves to a service.
    const projects = await getProjects('en')
    const mine = projects.find((p) => p.id === projectId)
    expect(mine).toBeTruthy()
    expect(mine?.serviceName).toBe(`Solar ${tag}`)
    // The relationship no longer populates to an object (service is gone).
    expect(typeof mine?.service === 'object' && mine?.service !== null).toBe(false)

    // And the deleted service's slug no longer resolves.
    expect(await getServiceBySlug(formatSlug(`Solar ${tag}`), 'en')).toBeNull()
  })
})
