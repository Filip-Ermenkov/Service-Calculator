import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@/payload.config'
import { getProjects, getServiceBySlug, getServices, mediaProps } from '@/lib/content'
import { lexicalToPlainText } from '@/lib/lexical'
import { filterProjects, projectCategories, type ProjectCard } from '@/lib/projects'
import { buildAlternates, pageMetadata } from '@/lib/seo'
import { formatSlug } from '@/lib/slug'
import {
  coerceFieldValue,
  coerceInputs,
  computePrice,
  fieldContribution,
  formatCurrency,
  toPricingFields,
  type PricingField,
} from '@/lib/pricing'
import { evaluateJsonLogic, isUsableFormula, type JsonLogic } from '@/lib/pricing/jsonlogic'
import {
  compileFormula,
  parseFormula,
  emptyFormula,
  type BuilderFormula,
} from '@/lib/pricing/formulaBuilder'

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

// ---- pricing evaluator (Phase 3, src/lib/pricing) — pure, no DB ------------

describe('evaluateJsonLogic (src/lib/pricing/jsonlogic.ts)', () => {
  it('reads variables, with a default for missing keys', () => {
    expect(evaluateJsonLogic({ var: 'a' }, { a: 7 })).toBe(7)
    expect(evaluateJsonLogic({ var: 'missing' }, {})).toBe(0)
    expect(evaluateJsonLogic({ var: ['missing', 42] }, {})).toBe(42)
  })

  it('does arithmetic with correct order of operations via nesting', () => {
    // (a + b) * c
    const rule: JsonLogic = { '*': [{ '+': [{ var: 'a' }, { var: 'b' }] }, { var: 'c' }] }
    expect(evaluateJsonLogic(rule, { a: 2, b: 3, c: 4 })).toBe(20)
  })

  it('supports +, -, *, /, unary -, min, max', () => {
    expect(evaluateJsonLogic({ '+': [1, 2, 3] }, {})).toBe(6)
    expect(evaluateJsonLogic({ '-': [10, 3, 2] }, {})).toBe(5)
    expect(evaluateJsonLogic({ '-': [5] }, {})).toBe(-5)
    expect(evaluateJsonLogic({ '*': [2, 3, 4] }, {})).toBe(24)
    expect(evaluateJsonLogic({ '/': [10, 4] }, {})).toBe(2.5)
    expect(evaluateJsonLogic({ min: [{ max: [10, 5] }, 8] }, {})).toBe(8)
  })

  it('division by zero yields a non-finite number (caller handles it)', () => {
    expect(Number.isFinite(evaluateJsonLogic({ '/': [5, 0] }, {}))).toBe(false)
  })

  it('throws on an unsupported operator or malformed rule', () => {
    expect(() => evaluateJsonLogic({ pow: [2, 3] } as never, {})).toThrow()
    expect(() => evaluateJsonLogic({ '+': [1], '*': [2] } as never, {})).toThrow()
  })

  it('isUsableFormula distinguishes real formulas from empty/absent', () => {
    expect(isUsableFormula(null)).toBe(false)
    expect(isUsableFormula(undefined)).toBe(false)
    expect(isUsableFormula({})).toBe(false)
    expect(isUsableFormula([])).toBe(false)
    expect(isUsableFormula({ '+': [1, 2] })).toBe(true)
  })
})

describe('computePrice + helpers (src/lib/pricing/index.ts)', () => {
  const fields: PricingField[] = toPricingFields([
    { fieldKey: 'area', label: 'Roof area', type: 'number', unitPrice: 150, sign: 'add', required: true },
    { fieldKey: 'panels', label: 'Panels', type: 'number', unitPrice: 200, sign: 'add' },
    { fieldKey: 'loyalty', label: 'Loyalty discount', type: 'toggle', unitPrice: 500, sign: 'subtract' },
    {
      fieldKey: 'grade', label: 'Grade', type: 'dropdown', unitPrice: 1, sign: 'add',
      options: [ { optionLabel: 'Standard', value: 0 }, { optionLabel: 'Premium', value: 1000 } ],
    },
  ])

  it('toPricingFields projects the CMS shape (defaults, options, sign)', () => {
    expect(fields[0]).toMatchObject({ fieldKey: 'area', type: 'number', unitPrice: 150, sign: 'add', required: true })
    expect(fields[2].sign).toBe('subtract')
    expect(fields[3].options).toEqual([{ label: 'Standard', value: 0 }, { label: 'Premium', value: 1000 }])
  })

  it('coerces number/dropdown/toggle raw inputs', () => {
    expect(coerceFieldValue(fields[0], '12.5')).toBe(12.5)
    expect(coerceFieldValue(fields[0], '')).toBe(0)
    expect(coerceFieldValue(fields[0], 'abc')).toBe(0)
    expect(coerceFieldValue(fields[2], true)).toBe(1)
    expect(coerceFieldValue(fields[2], false)).toBe(0)
    expect(coerceFieldValue(fields[3], '1000')).toBe(1000)
  })

  it('default path: total is the sum of signed contributions', () => {
    const inputs = coerceInputs(fields, { area: '10', panels: '4', loyalty: false, grade: '0' })
    const r = computePrice({ fields, inputs })
    expect(r.kind).toBe('price')
    if (r.kind === 'price') {
      expect(r.total).toBe(10 * 150 + 4 * 200) // 2300
      expect(r.usedFormula).toBe(false)
    }
  })

  it('honours sign (subtract) and dropdown values', () => {
    const inputs = coerceInputs(fields, { area: '10', panels: '0', loyalty: true, grade: '1000' })
    const r = computePrice({ fields, inputs })
    expect(r.kind === 'price' && r.total).toBe(10 * 150 - 500 + 1000) // 2000
  })

  it('§7: a non-positive total resolves to "contact"', () => {
    const inputs = coerceInputs(fields, { area: '0', panels: '0', loyalty: true, grade: '0' })
    const r = computePrice({ fields, inputs })
    expect(r.kind).toBe('contact')
  })

  it('a custom formula is authoritative and evaluated over raw values', () => {
    const formula = { '*': [{ '+': [{ var: 'area' }, { var: 'panels' }] }, 10] }
    const inputs = coerceInputs(fields, { area: '10', panels: '4' })
    const r = computePrice({ fields, formula, inputs })
    expect(r.kind === 'price' && r.total).toBe(140)
    expect(r.kind === 'price' && r.usedFormula).toBe(true)
  })

  it('a percentage adjustment (VAT) works via the formula', () => {
    const formula = { '*': [{ var: 'area' }, 1.17] }
    const r = computePrice({ fields, formula, inputs: coerceInputs(fields, { area: '100' }) })
    expect(r.kind === 'price' && r.total).toBe(117)
  })

  it('never throws — a bad/unsupported formula resolves to "contact"', () => {
    const r1 = computePrice({ fields, formula: { pow: [2, 3] } as never, inputs: {} })
    expect(r1.kind).toBe('contact')
    const r2 = computePrice({ fields, formula: { '/': [{ var: 'area' }, 0] }, inputs: coerceInputs(fields, { area: '5' }) })
    expect(r2.kind).toBe('contact')
  })

  it('rounds money to 2 decimals (guards float error)', () => {
    const one: PricingField[] = toPricingFields([
      { fieldKey: 'x', label: 'x', type: 'number', unitPrice: 0.1, sign: 'add' },
    ])
    const r = computePrice({ fields: one, inputs: { x: 3 } })
    expect(r.kind === 'price' && r.total).toBe(0.3) // not 0.30000000000000004
  })

  it('fieldContribution is null when a field has no unitPrice', () => {
    const noPrice = toPricingFields([{ fieldKey: 'n', label: 'n', type: 'number' }])[0]
    expect(fieldContribution(noPrice, 5)).toBeNull()
  })

  it('formatCurrency renders EUR for the active locale', () => {
    // Non-breaking spaces vary by ICU build; assert the essentials.
    expect(formatCurrency(1234.5, 'en')).toContain('€')
    expect(formatCurrency(1234.5, 'en')).toContain('1,234.5')
    expect(formatCurrency(1234.5, 'de')).toContain('€')
  })
})

describe('Formula Builder compile/parse (src/lib/pricing/formulaBuilder.ts)', () => {
  // The visual builder (Phase 3 part 2) is a view over canonical JSONLogic: it
  // must compile to the exact shape the shared evaluator runs, and parse that
  // shape back losslessly so an existing formula re-opens in the builder.
  const roundtrips = (m: BuilderFormula) =>
    expect(parseFormula(compileFormula(m))).toEqual(m)

  it('an empty model compiles to null (⇒ default per-field summation path)', () => {
    expect(compileFormula(emptyFormula())).toBeNull()
    expect(parseFormula(null)).toEqual(emptyFormula())
    expect(parseFormula({})).toEqual(emptyFormula())
  })

  it('compiles a field term to {var}×multiplier and round-trips', () => {
    const m: BuilderFormula = {
      terms: [{ kind: 'field', sign: 'add', fieldKey: 'area', multiplier: 12 }],
      adjustments: [],
    }
    expect(compileFormula(m)).toEqual({ '+': [{ '*': [{ var: 'area' }, 12] }] })
    roundtrips(m)
  })

  it('round-trips mixed +/− field and fixed terms', () => {
    roundtrips({
      terms: [
        { kind: 'field', sign: 'add', fieldKey: 'area', multiplier: 12 },
        { kind: 'field', sign: 'subtract', fieldKey: 'rebateArea', multiplier: 5 },
        { kind: 'fixed', sign: 'add', amount: 100 },
        { kind: 'fixed', sign: 'subtract', amount: 20 },
      ],
      adjustments: [],
    })
  })

  it('compiles a +10% VAT adjustment as ×1.1 and parses the percent back', () => {
    const m: BuilderFormula = {
      terms: [{ kind: 'field', sign: 'add', fieldKey: 'area', multiplier: 12 }],
      adjustments: [{ sign: 'add', percent: 10, label: '' }],
    }
    expect(compileFormula(m)).toEqual({
      '*': [{ '+': [{ '*': [{ var: 'area' }, 12] }] }, 1.1],
    })
    const back = parseFormula(compileFormula(m))!
    expect(back.adjustments).toEqual([{ sign: 'add', percent: 10, label: '' }])
  })

  it('compiles a −10% discount as ×0.9 and preserves adjustment order', () => {
    const m: BuilderFormula = {
      terms: [{ kind: 'fixed', sign: 'add', amount: 100 }],
      adjustments: [
        { sign: 'add', percent: 5, label: '' },
        { sign: 'subtract', percent: 10, label: '' },
      ],
    }
    const back = parseFormula(compileFormula(m))!
    expect(back.adjustments.map((a) => `${a.sign}${a.percent}`)).toEqual([
      'add5',
      'subtract10',
    ])
  })

  it('round-trips a group "(A + B) × field" and a "(…) × constant" subtract group', () => {
    roundtrips({
      terms: [
        {
          kind: 'group',
          sign: 'add',
          members: [
            { kind: 'field', fieldKey: 'a', multiplier: 1 },
            { kind: 'field', fieldKey: 'b', multiplier: 1 },
          ],
          factorType: 'field',
          factorConstant: 1,
          factorField: 'c',
        },
      ],
      adjustments: [],
    })
    roundtrips({
      terms: [
        {
          kind: 'group',
          sign: 'subtract',
          members: [
            { kind: 'field', fieldKey: 'a', multiplier: 2 },
            { kind: 'fixed', amount: 50 },
          ],
          factorType: 'constant',
          factorConstant: 3,
          factorField: '',
        },
      ],
      adjustments: [],
    })
  })

  it('returns null for non-builder formulas (min / division) ⇒ raw-JSON fallback', () => {
    expect(parseFormula({ min: [{ var: 'a' }, 100] })).toBeNull()
    expect(parseFormula({ '/': [{ var: 'a' }, 2] })).toBeNull()
  })

  it('the compiled formula evaluates to the same total the builder implies', () => {
    // (a + b) × 2, +10% VAT, a=3 b=7 ⇒ (10)×2=20 ⇒ ×1.1 = 22
    const m: BuilderFormula = {
      terms: [
        {
          kind: 'group',
          sign: 'add',
          members: [
            { kind: 'field', fieldKey: 'a', multiplier: 1 },
            { kind: 'field', fieldKey: 'b', multiplier: 1 },
          ],
          factorType: 'constant',
          factorConstant: 2,
          factorField: '',
        },
      ],
      adjustments: [{ sign: 'add', percent: 10, label: 'VAT' }],
    }
    const jl = compileFormula(m) as JsonLogic
    expect(evaluateJsonLogic(jl, { a: 3, b: 7 })).toBeCloseTo(22, 6)
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
