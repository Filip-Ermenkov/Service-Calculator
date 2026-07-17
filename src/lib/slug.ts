import type { Field, FieldHook } from 'payload'

/**
 * URL-slug helpers (TECHSPEC §6.2 / Phase 2b — clean service URLs).
 *
 * A slug is a single, canonical, locale-INDEPENDENT path segment for a document
 * (e.g. `/en/services/solar-panels`, `/fr/services/solar-panels`). Keeping one
 * slug across locales — rather than a per-locale slug — keeps hreflang alternates
 * pointing at the same path for every language and avoids a second source of
 * "which locale's slug is canonical?" ambiguity. FR/DE differ only by the `/xx`
 * prefix, which next-intl already owns.
 */

/**
 * Normalise any string into a URL-safe slug: lowercased, accent-folded (so
 * `Réalisations` → `realisations`, `Wärmepumpe` → `warmepumpe`), with every run
 * of non-alphanumeric characters collapsed to a single hyphen and no leading or
 * trailing hyphens. Deterministic and dependency-free.
 */
export function formatSlug(input: string): string {
  return input
    .normalize('NFKD') // split accented letters into base + combining mark
    .replace(/\p{Diacritic}/gu, '') // strip the combining marks (é → e)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-') // any non-alphanumeric run → one hyphen
    .replace(/^-+|-+$/g, '') // trim hyphens off both ends
}

/**
 * `beforeValidate` field hook. If the admin typed a slug, normalise and keep it;
 * otherwise derive it from the source field (the title). Deterministic and fast
 * (no DB reads — collision handling is left to the column's unique index, per
 * Payload's own guidance that field hooks stay side-effect-free).
 */
const formatSlugHook =
  (sourceField: string): FieldHook =>
  ({ value, originalDoc, data }) => {
    if (typeof value === 'string' && value.trim().length > 0) {
      return formatSlug(value)
    }
    const source = data?.[sourceField] ?? originalDoc?.[sourceField]
    if (typeof source === 'string' && source.length > 0) {
      return formatSlug(source)
    }
    return value
  }

/**
 * A reusable slug field: unique, indexed, auto-generated from `sourceField`
 * (default `title`) but editable, shown in the admin sidebar. Not localised.
 */
export function slugField(sourceField = 'title'): Field {
  return {
    name: 'slug',
    type: 'text',
    index: true,
    unique: true,
    admin: {
      position: 'sidebar',
      description:
        'URL path for this item, e.g. "solar-panels" → /services/solar-panels. ' +
        'Auto-filled from the title; edit to customise. Must be unique.',
    },
    hooks: {
      beforeValidate: [formatSlugHook(sourceField)],
    },
  }
}
