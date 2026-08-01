/**
 * Pure orchestration for document translation (Phase 5) — no Payload, no I/O, no
 * provider import, so it unit-tests cleanly. The hook (src/lib/translation/hook.ts)
 * wires these two functions to real Payload reads/writes and the translation
 * provider (AWS Translate).
 *
 * Flow, per content save (source locale = EN):
 *   1. analyzeChanges(): which registered fields changed vs the previous version,
 *      and the unique set of source strings those changed fields contain.
 *   2. For each target locale, translate that string set once (via the provider), then
 *      applyTranslations(): clone the CURRENT target-locale document and overwrite
 *      only the changed fields' leaves with their translations.
 *
 * Why clone the *target* doc rather than the EN doc: unchanged localized fields
 * must keep their existing FR/DE values (a manual edit, or a prior translation) —
 * cloning EN and writing it wholesale would clobber them with English. Cloning the
 * target and touching only changed leaves is what makes re-saves safe.
 */

import { collectLexicalStrings, rebuildLexicalWithTranslations } from './lexical'
import { resolveLeaves, topLevelKey, TRANSLATABLE_FIELDS } from './registry'

export interface ChangeAnalysis {
  /** Registry paths whose top-level field changed vs `previous` (all, on create). */
  changedPaths: string[]
  /** Unique, non-empty source strings across all changed fields (for the provider). */
  sources: string[]
}

const SYSTEM_FIELDS_TO_STRIP = ['id', 'createdAt', 'updatedAt', 'globalType'] as const

/**
 * Determine which registered fields changed and collect their source strings.
 * `previous` undefined/null ⇒ treat as a create (everything is "changed").
 */
export function analyzeChanges(
  slug: string,
  source: Record<string, unknown>,
  previous?: Record<string, unknown> | null,
): ChangeAnalysis {
  const fields = TRANSLATABLE_FIELDS[slug]
  if (!fields) return { changedPaths: [], sources: [] }

  const isCreate = previous === null || previous === undefined
  const changedTopCache = new Map<string, boolean>()
  const topChanged = (top: string): boolean => {
    if (isCreate) return true
    if (changedTopCache.has(top)) return changedTopCache.get(top)!
    const changed = stableStringify(source?.[top]) !== stableStringify(previous?.[top])
    changedTopCache.set(top, changed)
    return changed
  }

  const changedPaths: string[] = []
  const sources = new Set<string>()

  for (const field of fields) {
    if (!topChanged(topLevelKey(field.path))) continue
    changedPaths.push(field.path)
    for (const leaf of resolveLeaves(source, field.path)) {
      const value = leaf.get()
      if (field.type === 'plain') {
        if (typeof value === 'string' && value.trim().length > 0) sources.add(value)
      } else {
        collectLexicalStrings(value, sources)
      }
    }
  }

  return { changedPaths, sources: Array.from(sources) }
}

/**
 * Build the `data` payload for `payload.update({ locale: target, data })`:
 * a clone of the current target-locale document with the changed fields' leaves
 * replaced by their translations (from `map`; falls back to the source string
 * when a translation is absent — e.g. the provider disabled or an empty leaf).
 *
 * `base` is the target-locale document (cloned, never mutated). `source` is the
 * EN document (read-only). `changedPaths` comes from analyzeChanges().
 */
export function applyTranslations(
  slug: string,
  base: Record<string, unknown>,
  source: Record<string, unknown>,
  changedPaths: string[],
  map: Map<string, string>,
): Record<string, unknown> {
  const fields = TRANSLATABLE_FIELDS[slug]
  const data = structuredClone(base)
  for (const key of SYSTEM_FIELDS_TO_STRIP) delete data[key]
  if (!fields) return data

  const changed = new Set(changedPaths)
  for (const field of fields) {
    if (!changed.has(field.path)) continue
    const sourceLeaves = resolveLeaves(source, field.path)
    const dataLeaves = resolveLeaves(data, field.path)
    const count = Math.min(sourceLeaves.length, dataLeaves.length)
    for (let i = 0; i < count; i++) {
      const srcValue = sourceLeaves[i].get()
      if (field.type === 'plain') {
        if (typeof srcValue === 'string' && srcValue.trim().length > 0) {
          dataLeaves[i].set(map.get(srcValue) ?? srcValue)
        } else {
          // EN source empty/cleared ⇒ mirror it (keeps target consistent).
          dataLeaves[i].set(srcValue)
        }
      } else {
        dataLeaves[i].set(rebuildLexicalWithTranslations(srcValue, map))
      }
    }
  }
  return data
}

/**
 * Order-insensitive JSON stringify for change detection: object keys are sorted
 * so that a re-serialized-but-identical field (common with Payload/Lexical, where
 * key order isn't guaranteed) doesn't read as a spurious change and burn quota.
 * Arrays keep their order (order is meaningful there).
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value))
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(obj).sort()) sorted[key] = sortKeysDeep(obj[key])
    return sorted
  }
  return value
}
