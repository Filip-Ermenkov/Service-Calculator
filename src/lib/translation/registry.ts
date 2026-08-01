/**
 * The explicit registry of translatable fields per collection/global (Phase 5).
 *
 * Rather than reflect over Payload's field config at runtime, we declare exactly
 * which fields get auto-translated. This is intentional: it's readable, trivially
 * unit-testable, and makes "what does the machine translate?" a one-file answer
 * that a reviewer can check against the collections. Adding a localized field to
 * a collection is a deliberate two-line change here — which is the right amount
 * of friction for something that spends translation quota and writes content.
 *
 * Path syntax:
 *   • dots descend into groups:            "card.cardTitle"
 *   • "[]" marks an array to fan out over: "calculatorFields[].label"
 *   • both compose:               "calculatorFields[].options[].optionLabel"
 *
 * Every path listed here MUST correspond to a `localized: true` field in the
 * matching collection/global (src/collections, src/globals). Keep them in sync;
 * the integration test asserts each registry key is a real collection/global.
 */

export type TranslatableFieldType = 'plain' | 'richText'

export interface TranslatableField {
  /** Dot/`[]` path to the field, relative to the document root. */
  path: string
  /** `plain` = text/textarea/email leaf; `richText` = a Lexical JSON value. */
  type: TranslatableFieldType
}

export const TRANSLATABLE_FIELDS: Record<string, TranslatableField[]> = {
  services: [
    { path: 'title', type: 'plain' },
    { path: 'description', type: 'richText' },
    { path: 'card.cardTitle', type: 'plain' },
    { path: 'card.cardDescription', type: 'plain' },
    { path: 'disclaimer', type: 'richText' },
    { path: 'calculatorFields[].label', type: 'plain' },
    { path: 'calculatorFields[].options[].optionLabel', type: 'plain' },
  ],
  projects: [
    { path: 'title', type: 'plain' },
    { path: 'description', type: 'richText' },
  ],
  'career-listings': [
    { path: 'title', type: 'plain' },
    { path: 'description', type: 'richText' },
  ],
  'company-info': [{ path: 'aboutUsContent', type: 'richText' }],
  'legal-info': [{ path: 'privacyPolicyContent', type: 'richText' }],
}

/** The top-level field name a path descends from (used for change detection). */
export function topLevelKey(path: string): string {
  return path.split('.')[0].replace(/\[\]$/, '')
}

/**
 * A mutable reference to one leaf value inside a document, produced by walking a
 * registry path. Array paths yield one ref per matching row (in row order).
 */
export interface LeafRef {
  get(): unknown
  set(value: unknown): void
}

/**
 * Resolve a registry path against a concrete document object, returning a
 * get/set handle for every leaf it addresses. Missing intermediate objects/arrays
 * simply yield no leaves (never throws), so a document with, say, no
 * `calculatorFields` just contributes nothing for that path.
 *
 * Note: array segments are only ever intermediate in this app's registry
 * (a localized field always lives on an array *row*, never being the array
 * itself), so a trailing "[]" is treated as addressing nothing.
 */
export function resolveLeaves(root: unknown, path: string): LeafRef[] {
  const segments = path.split('.')
  const results: LeafRef[] = []

  const recurse = (current: unknown, idx: number): void => {
    if (current === null || current === undefined || typeof current !== 'object') return
    const seg = segments[idx]
    const isArray = seg.endsWith('[]')
    const key = isArray ? seg.slice(0, -2) : seg
    const isLast = idx === segments.length - 1
    const container = current as Record<string, unknown>

    if (isArray) {
      const arr = container[key]
      if (!Array.isArray(arr)) return
      // Array segments are always intermediate here; descend into each row.
      if (isLast) return
      for (const item of arr) recurse(item, idx + 1)
      return
    }

    if (isLast) {
      results.push({
        get: () => container[key],
        set: (value: unknown) => {
          container[key] = value
        },
      })
    } else {
      recurse(container[key], idx + 1)
    }
  }

  recurse(root, 0)
  return results
}
