import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  __setTranslateImplForTests,
  buildTranslationMap,
  isTranslationConfigured,
  translateTexts,
  type TargetLocale,
} from '@/lib/translation/provider'
import {
  collectLexicalStrings,
  isLexicalValue,
  rebuildLexicalWithTranslations,
} from '@/lib/translation/lexical'
import { resolveLeaves, topLevelKey } from '@/lib/translation/registry'
import {
  applyTranslations,
  changedTopKeys,
  collectSources,
  selectPathsToTranslate,
  stableStringify,
} from '@/lib/translation/translateDocument'

// Pure coverage for the Phase 5 translation pipeline (src/lib/translation/*).
// No Payload / DB / network: the AWS Translate provider is exercised via its
// test seam (__setTranslateImplForTests), everything else is deterministic pure
// logic. The real EN→FR/DE round-trip through the Payload hook is covered by the
// manual/e2e guide.

// A minimal Lexical value: one paragraph with two text leaves (one bold).
function lexicalDoc(...texts: string[]) {
  return {
    root: {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: texts.map((t, i) => ({
            type: 'text',
            text: t,
            format: i === 0 ? 0 : 1,
            version: 1,
          })),
        },
      ],
    },
  }
}

describe('provider.ts — AWS Translate config & batching (via test seam)', () => {
  const OLD = { ...process.env }
  beforeEach(() => {
    // Deterministic seam: echo the target + source so assertions are simple.
    __setTranslateImplForTests((text: string, target: TargetLocale) =>
      Promise.resolve(`${target.toUpperCase()}:${text}`),
    )
  })
  afterEach(() => {
    __setTranslateImplForTests(null)
    process.env = { ...OLD }
  })

  it('isTranslationConfigured reflects the TRANSLATE_ENABLED flag', () => {
    delete process.env.TRANSLATE_ENABLED
    expect(isTranslationConfigured()).toBe(false)
    process.env.TRANSLATE_ENABLED = 'false'
    expect(isTranslationConfigured()).toBe(false)
    process.env.TRANSLATE_ENABLED = 'true'
    expect(isTranslationConfigured()).toBe(true)
  })

  it('returns [] for empty input and preserves order for a batch', async () => {
    expect(await translateTexts([], 'fr')).toEqual([])
    expect(await translateTexts(['Hello', 'World'], 'fr')).toEqual(['FR:Hello', 'FR:World'])
  })

  it('propagates an underlying translate failure', async () => {
    __setTranslateImplForTests(() => Promise.reject(new Error('AWS Translate boom')))
    await expect(translateTexts(['x'], 'de')).rejects.toThrow(/AWS Translate boom/)
  })

  it('buildTranslationMap de-dupes and drops empty sources', async () => {
    const seen: string[] = []
    __setTranslateImplForTests((text: string, target: TargetLocale) => {
      seen.push(text)
      return Promise.resolve(`${target.toUpperCase()}:${text}`)
    })
    const map = await buildTranslationMap(['A', 'A', '  ', 'B'], 'de')
    expect(seen.sort()).toEqual(['A', 'B']) // unique + non-empty only, one call each
    expect(map.get('A')).toBe('DE:A')
    expect(map.get('B')).toBe('DE:B')
    expect(map.has('  ')).toBe(false)
  })
})

describe('lexical.ts', () => {
  it('collects only non-empty text leaves in pre-order', () => {
    const sink = new Set<string>()
    collectLexicalStrings(lexicalDoc('Hello ', 'brave', '   '), sink)
    expect(Array.from(sink)).toEqual(['Hello ', 'brave'])
  })

  it('rebuilds with translations, preserves structure, never mutates input', () => {
    const input = lexicalDoc('Hello', 'World')
    const map = new Map([
      ['Hello', 'Bonjour'],
      ['World', 'Monde'],
    ])
    const out = rebuildLexicalWithTranslations(input, map)
    // Input untouched
    expect(input.root.children[0].children[0].text).toBe('Hello')
    // Output translated, formatting mark preserved
    expect(out.root.children[0].children[0].text).toBe('Bonjour')
    expect(out.root.children[0].children[1].text).toBe('Monde')
    expect(out.root.children[0].children[1].format).toBe(1)
  })

  it('leaves untranslated leaves as-is and passes non-Lexical through', () => {
    const out = rebuildLexicalWithTranslations(lexicalDoc('Keep'), new Map())
    expect(out.root.children[0].children[0].text).toBe('Keep')
    expect(isLexicalValue('nope')).toBe(false)
    expect(rebuildLexicalWithTranslations('nope' as unknown, new Map())).toBe('nope')
  })
})

describe('registry.ts — resolveLeaves', () => {
  it('descends groups and fans out over nested arrays', () => {
    const doc = {
      title: 'T',
      card: { cardTitle: 'C' },
      calculatorFields: [
        { label: 'A', options: [{ optionLabel: 'a1' }, { optionLabel: 'a2' }] },
        { label: 'B', options: [] },
      ],
    }
    expect(resolveLeaves(doc, 'title').map((l) => l.get())).toEqual(['T'])
    expect(resolveLeaves(doc, 'card.cardTitle').map((l) => l.get())).toEqual(['C'])
    expect(resolveLeaves(doc, 'calculatorFields[].label').map((l) => l.get())).toEqual(['A', 'B'])
    expect(
      resolveLeaves(doc, 'calculatorFields[].options[].optionLabel').map((l) => l.get()),
    ).toEqual(['a1', 'a2'])
  })

  it('yields nothing for missing intermediates and never throws', () => {
    expect(resolveLeaves({}, 'calculatorFields[].label')).toEqual([])
    expect(resolveLeaves({ card: null }, 'card.cardTitle')).toEqual([])
    expect(resolveLeaves(null, 'title')).toEqual([])
  })

  it('set() mutates the addressed leaf', () => {
    const doc: Record<string, unknown> = { calculatorFields: [{ label: 'A' }] }
    resolveLeaves(doc, 'calculatorFields[].label')[0].set('X')
    expect((doc.calculatorFields as { label: string }[])[0].label).toBe('X')
  })

  it('topLevelKey strips array markers and group descent', () => {
    expect(topLevelKey('calculatorFields[].options[].optionLabel')).toBe('calculatorFields')
    expect(topLevelKey('card.cardTitle')).toBe('card')
    expect(topLevelKey('title')).toBe('title')
  })
})

describe('translateDocument.ts — changedTopKeys', () => {
  it('treats a create (no previous) as every top-level field changed', () => {
    const src = { title: 'Solar', description: lexicalDoc('Great panels') }
    const changed = changedTopKeys('services', src)
    expect(changed.has('title')).toBe(true)
    expect(changed.has('description')).toBe(true)
    expect(changed.has('card')).toBe(true)
  })

  it('detects only the top-level fields whose value changed', () => {
    const prev = { title: 'Solar', description: lexicalDoc('Old') }
    const src = { title: 'Solar', description: lexicalDoc('New') }
    const changed = changedTopKeys('services', src, prev)
    expect(Array.from(changed)).toEqual(['description'])
  })

  it('is order-insensitive on object keys (no spurious change)', () => {
    const prev = { title: 'Solar', card: { cardTitle: 'X', cardDescription: 'Y' } }
    const src = { title: 'Solar', card: { cardDescription: 'Y', cardTitle: 'X' } }
    expect(changedTopKeys('services', src, prev).has('card')).toBe(false)
  })

  it('returns an empty set for a collection with no registered fields', () => {
    expect(changedTopKeys('media', { anything: 1 }).size).toBe(0)
  })
})

describe('translateDocument.ts — selectPathsToTranslate (self-healing)', () => {
  it('selects a changed field even if the target already differs', () => {
    const source = { title: 'Solar', description: lexicalDoc('Panels') }
    const base = { title: 'Soleil', description: lexicalDoc('Panneaux') }
    const changed = new Set(['title'])
    expect(selectPathsToTranslate('services', source, base, changed)).toContain('title')
  })

  it('selects an UNTRANSLATED fallback field even when nothing changed', () => {
    // Target === source ⇒ still the EN fallback ⇒ must be (re)translated.
    const source = { title: 'Solar', description: lexicalDoc('Panels') }
    const base = { title: 'Solar', description: lexicalDoc('Panels') }
    const paths = selectPathsToTranslate('services', source, base, new Set())
    expect(paths).toContain('title')
    expect(paths).toContain('description')
  })

  it('leaves a translated/overridden field alone when unchanged', () => {
    const source = { title: 'Solar' }
    const base = { title: 'Énergie solaire' } // distinct ⇒ a real translation/override
    expect(selectPathsToTranslate('services', source, base, new Set())).not.toContain('title')
  })

  it('is depth/ordering-robust: an untranslated card (with a media id) is selected', () => {
    // card holds a non-localized cardImage id + localized text. When the text is
    // still the fallback, the whole top-level `card` deep-equals ⇒ selected.
    const source = { card: { cardTitle: 'Roof', cardDescription: 'Nice', cardImage: 5 } }
    const base = { card: { cardTitle: 'Roof', cardDescription: 'Nice', cardImage: 5 } }
    const paths = selectPathsToTranslate('services', source, base, new Set())
    expect(paths).toContain('card.cardTitle')
    expect(paths).toContain('card.cardDescription')
  })
})

describe('translateDocument.ts — collectSources', () => {
  it('gathers unique non-empty strings across selected paths (plain + rich)', () => {
    const source = {
      title: 'Solar',
      description: lexicalDoc('Solar', 'panels'),
      card: { cardTitle: '', cardDescription: 'Blurb' },
    }
    const sources = collectSources('services', source, [
      'title',
      'description',
      'card.cardTitle',
      'card.cardDescription',
    ])
    expect(sources.sort()).toEqual(['Blurb', 'Solar', 'panels']) // 'Solar' de-duped, '' dropped
  })
})

describe('translateDocument.ts — applyTranslations', () => {
  const map = new Map([
    ['Solar', 'Solaire'],
    ['New', 'Nouveau'],
  ])

  it('overwrites only selected leaves and keeps unselected target values', () => {
    const source = { title: 'Solar', description: lexicalDoc('New') }
    // Target (FR) already has a good title translation we must NOT clobber.
    const base = {
      id: 7,
      title: 'Énergie solaire',
      description: lexicalDoc('Ancien'),
      _status: 'published',
    }
    const data = applyTranslations('services', base, source, ['description'], map)
    // Unselected title kept from base (the existing FR value), not overwritten
    expect(data.title).toBe('Énergie solaire')
    // Selected description translated
    expect((data.description as ReturnType<typeof lexicalDoc>).root.children[0].children[0].text).toBe(
      'Nouveau',
    )
    // System field stripped
    expect(data.id).toBeUndefined()
    // base not mutated
    expect((base.description as ReturnType<typeof lexicalDoc>).root.children[0].children[0].text).toBe(
      'Ancien',
    )
  })

  it('mirrors an emptied EN source into the target', () => {
    const source = { title: '' }
    const base = { title: 'Énergie solaire' }
    const data = applyTranslations('services', base, source, ['title'], new Map())
    expect(data.title).toBe('')
  })

  it('falls back to the source string when no translation exists (no key case)', () => {
    const source = { title: 'Solar' }
    const base = { title: 'old' }
    const data = applyTranslations('services', base, source, ['title'], new Map())
    expect(data.title).toBe('Solar')
  })

  it('translates nested array leaves (calculator labels)', () => {
    const source = {
      calculatorFields: [{ label: 'Solar', options: [{ optionLabel: 'New' }] }],
    }
    const base = {
      calculatorFields: [{ label: 'x', options: [{ optionLabel: 'y' }] }],
    }
    const data = applyTranslations(
      'services',
      base,
      source,
      ['calculatorFields[].label', 'calculatorFields[].options[].optionLabel'],
      map,
    )
    const cf = data.calculatorFields as { label: string; options: { optionLabel: string }[] }[]
    expect(cf[0].label).toBe('Solaire')
    expect(cf[0].options[0].optionLabel).toBe('Nouveau')
  })
})

describe('translateDocument.ts — stableStringify', () => {
  it('is order-insensitive on objects but order-sensitive on arrays', () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }))
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]))
  })
})
