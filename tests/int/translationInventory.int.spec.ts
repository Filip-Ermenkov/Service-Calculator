import { describe, expect, it } from 'vitest'

import {
  buildDocumentEntries,
  buildInventory,
  deriveStatus,
  humanizePath,
  localePreview,
  setPlainLeaf,
  summarize,
  type InventoryInput,
} from '@/lib/translation/inventory'

// Pure coverage for the Translation Management inventory (Phase 5 part 2,
// src/lib/translation/inventory.ts). The full admin screen (view render, auth
// gate, live edit → /api/admin/translations write) is covered by the manual E2E
// guide; this asserts the flattening, status derivation and leaf-write logic that
// the screen and the write route both depend on.

/** Minimal Lexical value with a single paragraph of text. */
function lex(text: string) {
  return {
    root: {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [{ type: 'text', text, version: 1 }],
          version: 1,
        },
      ],
      direction: null,
      format: '',
      indent: 0,
      version: 1,
    },
  }
}

describe('inventory — localePreview', () => {
  it('returns plain strings as-is and empty for nullish', () => {
    expect(localePreview('plain', 'Hello')).toBe('Hello')
    expect(localePreview('plain', undefined)).toBe('')
    expect(localePreview('plain', null)).toBe('')
    expect(localePreview('plain', 42)).toBe('') // non-string ⇒ empty
  })

  it('joins rich-text leaves into a preview', () => {
    expect(localePreview('richText', lex('Bonjour le monde'))).toBe('Bonjour le monde')
    expect(localePreview('richText', undefined)).toBe('')
    expect(localePreview('richText', { root: { children: [] } })).toBe('')
  })
})

describe('inventory — deriveStatus', () => {
  it('flags an empty source', () => {
    expect(deriveStatus('', 'anything')).toBe('empty')
    expect(deriveStatus('   ', '')).toBe('empty')
  })

  it('flags a missing or fallback target as untranslated', () => {
    expect(deriveStatus('Hello', '')).toBe('untranslated')
    expect(deriveStatus('Hello', 'Hello')).toBe('untranslated') // still the EN fallback
    expect(deriveStatus('Hello', '  Hello  ')).toBe('untranslated') // trims
  })

  it('marks a distinct value as translated', () => {
    expect(deriveStatus('Hello', 'Bonjour')).toBe('translated')
  })
})

describe('inventory — humanizePath', () => {
  it('humanizes dotted + camelCase paths and de-dupes repeated nouns', () => {
    expect(humanizePath('title')).toBe('Title')
    expect(humanizePath('card.cardTitle')).toBe('Card Title')
    expect(humanizePath('card.cardDescription')).toBe('Card Description')
    expect(humanizePath('calculatorFields[].label')).toBe('Calculator Fields Label')
    expect(humanizePath('calculatorFields[].options[].optionLabel')).toBe(
      'Calculator Fields Options Option Label',
    )
  })
})

describe('inventory — buildDocumentEntries', () => {
  const servicesInput: InventoryInput = {
    entity: 'services',
    isGlobal: false,
    docId: 7,
    docLabel: 'Solar Panels',
    data: {
      id: 7,
      title: { en: 'Solar Panels', fr: 'Panneaux solaires', de: 'Solarmodule' },
      description: { en: lex('Great service'), fr: lex('Great service'), de: lex('Toller Dienst') },
      card: {
        cardTitle: { en: 'Solar', fr: 'Solaire' }, // de missing ⇒ untranslated
        cardDescription: { en: 'Save energy' }, // fr/de missing
        cardImage: 5, // non-localized, ignored by the registry
      },
      calculatorFields: [
        { label: { en: 'Roof area', fr: 'Surface du toit', de: 'Dachfläche' }, unitPrice: 10 },
        { label: { en: 'Panels', fr: 'Panels' } }, // fr==en fallback, de missing
      ],
    },
  }

  it('flattens every registered leaf with per-locale status', () => {
    const entries = buildDocumentEntries(servicesInput)
    const byField = (label: string, idx = 0) =>
      entries.filter((e) => e.fieldLabel === label)[idx]

    // title — fully translated
    const title = byField('Title')
    expect(title.en).toBe('Solar Panels')
    expect(title.targets.fr).toEqual({ value: 'Panneaux solaires', status: 'translated' })
    expect(title.targets.de.status).toBe('translated')
    expect(title.type).toBe('plain')

    // description (rich text) — fr is still the EN fallback, de translated
    const desc = byField('Description')
    expect(desc.type).toBe('richText')
    expect(desc.targets.fr.status).toBe('untranslated')
    expect(desc.targets.de.status).toBe('translated')

    // card.cardTitle — de missing
    const cardTitle = byField('Card Title')
    expect(cardTitle.targets.fr.status).toBe('translated')
    expect(cardTitle.targets.de.status).toBe('untranslated')

    // calculatorFields[].label — two rows, indices 0 and 1
    const labels = entries.filter((e) => e.fieldLabel === 'Calculator Fields Label')
    expect(labels).toHaveLength(2)
    expect(labels[0].leafIndex).toBe(0)
    expect(labels[0].targets.de.status).toBe('translated')
    expect(labels[1].leafIndex).toBe(1)
    expect(labels[1].leafCount).toBe(2)
    expect(labels[1].targets.fr.status).toBe('untranslated') // fr == en
  })

  it('skips leaves that are blank everywhere', () => {
    const input: InventoryInput = {
      entity: 'projects',
      isGlobal: false,
      docId: 1,
      docLabel: 'Empty',
      data: { id: 1, title: { en: '' }, description: undefined },
    }
    expect(buildDocumentEntries(input)).toHaveLength(0)
  })

  it('produces stable, unique ids', () => {
    const entries = buildDocumentEntries(servicesInput)
    const ids = entries.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every((id) => /^[a-zA-Z0-9_]+$/.test(id))).toBe(true)
  })
})

describe('inventory — summarize', () => {
  it('counts untranslated leaves per target', () => {
    const inputs: InventoryInput[] = [
      {
        entity: 'projects',
        isGlobal: false,
        docId: 1,
        docLabel: 'P1',
        data: {
          id: 1,
          title: { en: 'Roof', fr: 'Toit', de: 'Dach' }, // both translated
          description: { en: lex('x'), fr: lex('x'), de: lex('y') }, // fr fallback
        },
      },
    ]
    const stats = summarize(buildInventory(inputs))
    expect(stats.total).toBe(2)
    expect(stats.untranslated.fr).toBe(1)
    expect(stats.untranslated.de).toBe(0)
  })
})

describe('inventory — setPlainLeaf (write reconstruction)', () => {
  it('sets a top-level plain leaf without touching siblings', () => {
    const target = { id: 3, title: 'Toit', slug: 'roof' }
    const res = setPlainLeaf(target, 'title', 0, 'Toiture')
    expect(res).toEqual({ topLevelField: 'title', fieldValue: 'Toiture' })
    // input not mutated
    expect(target.title).toBe('Toit')
  })

  it('sets a nested group leaf and returns the whole group', () => {
    const target = { card: { cardTitle: 'Solaire', cardDescription: undefined, cardImage: 5 } }
    const res = setPlainLeaf(target, 'card.cardTitle', 0, 'Énergie solaire')
    expect(res?.topLevelField).toBe('card')
    expect(res?.fieldValue).toEqual({
      cardTitle: 'Énergie solaire',
      cardDescription: undefined,
      cardImage: 5,
    })
  })

  it('sets one array-row leaf and preserves the rest of the array', () => {
    const target = {
      calculatorFields: [
        { label: 'Surface', unitPrice: 10 },
        { label: 'Panneaux', unitPrice: 20 },
      ],
    }
    const res = setPlainLeaf(target, 'calculatorFields[].label', 1, 'Modules')
    expect(res?.topLevelField).toBe('calculatorFields')
    expect(res?.fieldValue).toEqual([
      { label: 'Surface', unitPrice: 10 },
      { label: 'Modules', unitPrice: 20 },
    ])
  })

  it('returns null when the leaf index is out of range', () => {
    const target = { title: 'Toit' }
    expect(setPlainLeaf(target, 'title', 5, 'x')).toBeNull()
  })
})
