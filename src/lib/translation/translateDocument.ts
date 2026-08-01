/**
 * Pure orchestration for document translation (Phase 5) — no Payload, no I/O, no
 * provider import, so it unit-tests cleanly. The hook (src/lib/translation/hook.ts)
 * wires these functions to real Payload reads/writes and the translation provider
 * (AWS Translate).
 *
 * Flow, per content save (source locale = EN):
 *   1. changedTopKeys(): which registered top-level fields changed vs the previous
 *      version (all of them on a create).
 *   2. For each target locale, read that locale's current document and call
 *      selectPathsToTranslate(): a field is (re)translated if its EN source
 *      CHANGED, or if the target is still just the untranslated EN fallback
 *      (base deep-equals source). The second condition is what makes the pipeline
 *      self-healing — content that existed before translation was enabled, fields
 *      not touched in an edit, or a field a previous run failed on all get filled
 *      on the next save — while a real translation or a manual override (which
 *      differ from the source) are left untouched.
 *   3. collectSources() → translate once → applyTranslations(): clone the target
 *      document and overwrite only the selected fields' leaves.
 *
 * Why clone the *target* doc rather than the EN doc: unchanged localized fields
 * must keep their existing FR/DE values (a manual override, or a prior
 * translation) — cloning EN wholesale would clobber them with English. Cloning
 * the target and touching only selected leaves is what makes re-saves safe.
 *
 * DEPTH CONTRACT: `source` and `base` passed here MUST be read at the SAME depth
 * (the hook uses depth 0 for both). The fallback check deep-compares whole
 * top-level fields, so a depth mismatch on a relationship/upload field (e.g. the
 * service `card`'s image: an id at depth 0 vs a populated object at depth 1)
 * would make an untranslated field look "already translated" and never fill it.
 */

import { collectLexicalStrings, rebuildLexicalWithTranslations } from './lexical'
import { resolveLeaves, topLevelKey, TRANSLATABLE_FIELDS } from './registry'

const SYSTEM_FIELDS_TO_STRIP = ['id', 'createdAt', 'updatedAt', 'globalType'] as const

/**
 * Top-level fields whose value changed vs the previous version. `previous`
 * null/undefined ⇒ a create (every registered top-level field counts as changed).
 */
export function changedTopKeys(
  slug: string,
  source: Record<string, unknown>,
  previous?: Record<string, unknown> | null,
): Set<string> {
  const fields = TRANSLATABLE_FIELDS[slug]
  if (!fields) return new Set()
  const tops = new Set(fields.map((f) => topLevelKey(f.path)))
  if (previous === null || previous === undefined) return tops

  const changed = new Set<string>()
  for (const top of tops) {
    if (stableStringify(source?.[top]) !== stableStringify(previous?.[top])) changed.add(top)
  }
  return changed
}

/**
 * The registry paths to (re)translate for one target locale: a field is selected
 * if its top-level key CHANGED, or if the target is still the untranslated EN
 * fallback (base deep-equals source for that top-level field). Fields with a
 * distinct target value (translated or manually overridden) that didn't change
 * are left alone.
 *
 * `source` and `base` must be read at the same depth (see the DEPTH CONTRACT).
 */
export function selectPathsToTranslate(
  slug: string,
  source: Record<string, unknown>,
  base: Record<string, unknown>,
  changedTops: Set<string>,
): string[] {
  const fields = TRANSLATABLE_FIELDS[slug]
  if (!fields) return []

  const fallbackCache = new Map<string, boolean>()
  const isFallback = (top: string): boolean => {
    if (fallbackCache.has(top)) return fallbackCache.get(top)!
    const fb = stableStringify(base?.[top]) === stableStringify(source?.[top])
    fallbackCache.set(top, fb)
    return fb
  }

  const paths: string[] = []
  for (const field of fields) {
    const top = topLevelKey(field.path)
    if (changedTops.has(top) || isFallback(top)) paths.push(field.path)
  }
  return paths
}

/** Unique, non-empty EN source strings across the given registry paths. */
export function collectSources(
  slug: string,
  source: Record<string, unknown>,
  paths: string[],
): string[] {
  const fields = TRANSLATABLE_FIELDS[slug]
  if (!fields) return []
  const selected = new Set(paths)
  const out = new Set<string>()
  for (const field of fields) {
    if (!selected.has(field.path)) continue
    for (const leaf of resolveLeaves(source, field.path)) {
      const value = leaf.get()
      if (field.type === 'plain') {
        if (typeof value === 'string' && value.trim().length > 0) out.add(value)
      } else {
        collectLexicalStrings(value, out)
      }
    }
  }
  return Array.from(out)
}

/**
 * Build the `data` payload for `payload.update({ locale: target, data })`:
 * a clone of the current target-locale document with the selected fields' leaves
 * replaced by their translations (from `map`; falls back to the source string
 * when a translation is absent — e.g. the provider disabled or an empty leaf).
 *
 * `base` is the target-locale document (cloned, never mutated). `source` is the
 * EN document (read-only). `paths` comes from selectPathsToTranslate().
 */
export function applyTranslations(
  slug: string,
  base: Record<string, unknown>,
  source: Record<string, unknown>,
  paths: string[],
  map: Map<string, string>,
): Record<string, unknown> {
  const fields = TRANSLATABLE_FIELDS[slug]
  const data = structuredClone(base)
  for (const key of SYSTEM_FIELDS_TO_STRIP) delete data[key]
  if (!fields) return data

  const selected = new Set(paths)
  for (const field of fields) {
    if (!selected.has(field.path)) continue
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
 * Order-insensitive JSON stringify for change/fallback detection: object keys are
 * sorted so a re-serialized-but-identical field (common with Payload/Lexical,
 * where key order isn't guaranteed) doesn't read as a spurious difference and
 * burn quota. Arrays keep their order (order is meaningful there).
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
