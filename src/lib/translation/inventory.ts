/**
 * Translation Management inventory (Phase 5 part 2) — the PURE core of the admin
 * Translation Management screen (FUNCTIONALITY.md §5.7).
 *
 * Given documents read at `locale: 'all'` (so every localized leaf is a
 * `{ en, fr, de }` object of the RAW stored values — Payload applies no fallback
 * for `locale: 'all'`), this module flattens them into a list of per-leaf
 * `TranslationEntry` rows: one row per translatable string, carrying the EN
 * source alongside each target locale's current value and a derived status.
 *
 * It is deliberately free of Payload/React/I-O so it unit-tests cleanly (mirroring
 * translateDocument.ts). The server view (TranslationsView.tsx) supplies the
 * already-read documents; the write path (src/app/api/admin/translations) reuses
 * the SAME registry + resolveLeaves machinery to address a leaf back for saving.
 *
 * STATUS is derived live, with no persisted metadata:
 *   • 'empty'        — the EN source leaf is blank ⇒ nothing to translate.
 *   • 'untranslated' — the target leaf is absent, or equals the EN source
 *                      (i.e. it is still the fallback) ⇒ needs attention.
 *   • 'translated'   — the target leaf has a distinct, non-empty value.
 * Because there is no shadow-collection metadata, this screen intentionally does
 * NOT distinguish a machine auto-translation from a manual override, nor flag
 * "source changed since an override" — those are a documented future refinement
 * that would require a persistence layer (a schema migration). See docs.
 */

import { collectLexicalStrings } from './lexical'
import {
  resolveLeaves,
  topLevelKey,
  TRANSLATABLE_FIELDS,
  type TranslatableFieldType,
} from './registry'

/** The languages this site translates INTO (EN is the authoring source). */
export const TARGET_LOCALES = ['fr', 'de'] as const
export type TargetLocaleCode = (typeof TARGET_LOCALES)[number]

export type LeafStatus = 'translated' | 'untranslated' | 'empty'

/** A localized leaf value as returned under `locale: 'all'`. */
export type LocaleMap = Partial<Record<'en' | 'fr' | 'de', unknown>>

/** One translatable string, flattened for the admin table. */
export interface TranslationEntry {
  /** Stable, URL-safe id: entity[/docId]/registryPath/leafIndex. */
  id: string
  /** Collection or global slug (e.g. 'services', 'company-info'). */
  entity: string
  isGlobal: boolean
  /** Document id for collections; undefined for globals. */
  docId?: string | number
  /** Human label for the owning document (EN title, or the global's name). */
  docLabel: string
  /** Registry path with `[]` markers (e.g. 'calculatorFields[].label'). */
  registryPath: string
  /** Index of this leaf within resolveLeaves(doc, registryPath) — stable addresser. */
  leafIndex: number
  /** How many leaves that path yielded (so the UI can suffix an index only when needed). */
  leafCount: number
  /** 'plain' text leaf vs 'richText' (Lexical) leaf. */
  type: TranslatableFieldType
  /** Human field label derived from the path (e.g. 'Card Title'). */
  fieldLabel: string
  /** The EN source text (plain string, or a joined preview for rich text). */
  en: string
  /** Per-target current value + derived status. */
  targets: Record<TargetLocaleCode, { value: string; status: LeafStatus }>
}

/** A document to inventory, already read at `locale: 'all'`, depth 0. */
export interface InventoryInput {
  entity: string
  isGlobal: boolean
  docId?: string | number
  docLabel: string
  /** The raw `locale: 'all'` document object. */
  data: Record<string, unknown>
}

/** Extract plain preview text from a single locale's stored value. */
export function localePreview(type: TranslatableFieldType, value: unknown): string {
  if (value === null || value === undefined) return ''
  if (type === 'plain') {
    return typeof value === 'string' ? value : ''
  }
  // richText: collect the Lexical text leaves and join them.
  const sink = new Set<string>()
  collectLexicalStrings(value, sink)
  return Array.from(sink).join(' ').trim()
}

/** Derive a target-locale status from its preview vs the EN preview. */
export function deriveStatus(enPreview: string, targetPreview: string): LeafStatus {
  if (enPreview.trim().length === 0) return 'empty'
  if (targetPreview.trim().length === 0) return 'untranslated'
  // Equal to the source ⇒ still the fallback (never machine/hand translated).
  if (targetPreview.trim() === enPreview.trim()) return 'untranslated'
  return 'translated'
}

const ACRONYMS = new Set(['id', 'url', 'seo'])

/** Turn a registry path into a human field label ('card.cardTitle' → 'Card Title'). */
export function humanizePath(path: string): string {
  const parts = path
    .replace(/\[\]/g, '')
    .split('.')
    .filter(Boolean)
  const words: string[] = []
  for (const part of parts) {
    // split camelCase into words
    for (const w of part.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/\s+/)) {
      if (!w) continue
      words.push(ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))
    }
  }
  // Collapse a duplicated leading noun ('Card Card Title' → 'Card Title').
  const deduped: string[] = []
  for (const w of words) {
    if (deduped.length && deduped[deduped.length - 1].toLowerCase() === w.toLowerCase()) continue
    deduped.push(w)
  }
  return deduped.join(' ')
}

function slugSegment(value: string | number): string {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '_')
}

/**
 * Flatten one document's registered translatable fields into entries.
 * A leaf whose EN source is blank AND whose targets are all blank is skipped
 * entirely (nothing to review); a blank-EN leaf with a stray target value is kept
 * (so the admin can see/clear it).
 */
export function buildDocumentEntries(input: InventoryInput): TranslationEntry[] {
  const fields = TRANSLATABLE_FIELDS[input.entity]
  if (!fields) return []
  const entries: TranslationEntry[] = []

  for (const field of fields) {
    const leaves = resolveLeaves(input.data, field.path)
    const label = humanizePath(field.path)
    leaves.forEach((leaf, leafIndex) => {
      const map = (leaf.get() ?? {}) as LocaleMap
      const en = localePreview(field.type, map.en)
      const targets = {} as TranslationEntry['targets']
      let anyTargetText = false
      for (const locale of TARGET_LOCALES) {
        const value = localePreview(field.type, map[locale])
        if (value.trim().length > 0) anyTargetText = true
        targets[locale] = { value, status: deriveStatus(en, value) }
      }
      // Skip a leaf that has nothing anywhere (blank source + blank targets).
      if (en.trim().length === 0 && !anyTargetText) return

      const idParts = [input.entity]
      if (input.docId !== undefined) idParts.push(slugSegment(input.docId))
      idParts.push(slugSegment(field.path), String(leafIndex))

      entries.push({
        id: idParts.join('__'),
        entity: input.entity,
        isGlobal: input.isGlobal,
        docId: input.docId,
        docLabel: input.docLabel,
        registryPath: field.path,
        leafIndex,
        leafCount: leaves.length,
        type: field.type,
        fieldLabel: label,
        en,
        targets,
      })
    })
  }

  return entries
}

/** Flatten many documents into a single ordered entry list. */
export function buildInventory(inputs: InventoryInput[]): TranslationEntry[] {
  return inputs.flatMap(buildDocumentEntries)
}

export interface InventoryStats {
  total: number
  untranslated: Record<TargetLocaleCode, number>
}

/** Count leaves needing attention per target locale (for the header summary). */
export function summarize(entries: TranslationEntry[]): InventoryStats {
  const untranslated = { fr: 0, de: 0 } as Record<TargetLocaleCode, number>
  for (const e of entries) {
    for (const locale of TARGET_LOCALES) {
      if (e.targets[locale].status === 'untranslated') untranslated[locale] += 1
    }
  }
  return { total: entries.length, untranslated }
}

/**
 * Reconstruct the single top-level field that owns a plain leaf, with that leaf
 * set to `value`, for a minimal `payload.update`. Operates on a clone of a
 * target-locale document read with `fallbackLocale: false` (so untouched
 * untranslated leaves stay absent and are never persisted as EN copies).
 *
 * Returns the owning top-level field name and its new value, or null if the leaf
 * index doesn't resolve (e.g. the document changed shape between read and write).
 * PLAIN leaves only — rich text is edited in the native localized editor.
 */
export function setPlainLeaf(
  targetDoc: Record<string, unknown>,
  registryPath: string,
  leafIndex: number,
  value: string,
): { topLevelField: string; fieldValue: unknown } | null {
  const clone = structuredClone(targetDoc)
  const leaves = resolveLeaves(clone, registryPath)
  const leaf = leaves[leafIndex]
  if (!leaf) return null
  leaf.set(value)
  const topLevelField = topLevelKey(registryPath)
  return { topLevelField, fieldValue: clone[topLevelField] }
}
