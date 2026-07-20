/**
 * Quote view-model assembly (Phase 4 — FUNCTIONALITY §4, TECHSPEC §6.5).
 *
 * Turns a service's calculator fields + the visitor's raw inputs into a fully
 * resolved, presentation-ready model for the PDF template. Like `@/lib/pricing`,
 * this is a **pure module** — no React, no next-intl runtime, no DB — so it is
 * unit-testable in isolation and produces the exact same total the on-screen
 * calculator shows (it calls the very same `computePrice`). The PDF total can
 * therefore never drift from the estimate the visitor saw (TECHSPEC §3/§6.3).
 *
 * All localized strings are passed in via `QuoteText` (resolved from the
 * next-intl catalog by the caller), so the PDF is produced entirely in the
 * language the visitor had selected at generation time (FUNCTIONALITY §4 Language).
 */

import {
  coerceInputs,
  computePrice,
  formatCurrency,
  type JsonLogic,
  type PricingField,
  type RawInput,
} from '@/lib/pricing'

/** Every user-visible string the PDF needs, already in the target language. */
export interface QuoteText {
  /** Document heading, e.g. "Price Estimate". */
  title: string
  /** Prominent estimate-only disclaimer heading + body (FUNCTIONALITY §4.2). */
  disclaimerTitle: string
  disclaimerBody: string
  /** Row labels in the meta block. */
  serviceLabel: string
  dateLabel: string
  /** Column headers for the parameters table (FUNCTIONALITY §4.4). */
  paramColumn: string
  valueColumn: string
  priceColumn: string
  /** The prominent total row (FUNCTIONALITY §4.5). */
  totalLabel: string
  /** Shown in place of a figure when the total is non-positive/incomplete (§7). */
  contactForPrice: string
  /** Footer invitation to get in touch (FUNCTIONALITY §4.6). */
  footerNote: string
  /** Contact detail labels in the header/footer. */
  phoneLabel: string
  emailLabel: string
  /** Value placeholders. */
  notSpecified: string
  yes: string
  no: string
}

/** Company identity for the header/footer (FUNCTIONALITY §4.1/§4.6). */
export interface QuoteCompany {
  name: string
  phone: string | null
  email: string | null
}

/** One resolved parameter row, all strings ready to print. */
export interface QuoteLine {
  label: string
  /** The visitor's entered value, formatted for display (or the "—" placeholder). */
  valueDisplay: string
  /** Signed contribution formatted as currency, or null when not shown. */
  contributionDisplay: string | null
}

/** The complete, presentation-ready quote (all strings pre-formatted). */
export interface QuoteModel {
  locale: string
  company: QuoteCompany
  serviceTitle: string
  dateDisplay: string
  lines: QuoteLine[]
  /** True when a total figure is shown; false → the "contact us" state (§7). */
  hasTotal: boolean
  /** Formatted currency total, present iff `hasTotal`. */
  totalDisplay: string | null
  /** Whether any contribution column has a value (drives table layout). */
  showContributions: boolean
  text: QuoteText
}

/** Locale-aware long date (e.g. "20 July 2026" / "20 juillet 2026"). */
export function formatQuoteDate(date: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(date)
}

/**
 * A required *number* field left blank is "missing" (an explicit 0 counts as
 * filled) — the exact rule the on-screen calculator uses. Dropdowns/toggles
 * always carry a value, so only number fields can be missing.
 */
function isMissingRequired(field: PricingField, raw: RawInput): boolean {
  return (
    field.required &&
    field.type === 'number' &&
    (raw === '' || raw === null || raw === undefined)
  )
}

/** Human-readable display of a single field's entered value. */
function valueDisplay(field: PricingField, raw: RawInput, text: QuoteText): string {
  if (field.type === 'toggle') {
    const on = raw === true || raw === 'true' || raw === 'on' || raw === 1
    return on ? text.yes : text.no
  }
  if (field.type === 'dropdown') {
    const match = field.options.find((o) => String(o.value) === String(raw))
    return match?.label ?? text.notSpecified
  }
  // number
  if (raw === '' || raw === null || raw === undefined) return text.notSpecified
  return String(raw)
}

/**
 * Build the presentation-ready quote model from the authoritative service data
 * and the visitor's raw inputs. Mirrors the public calculator's gating exactly:
 * if any required number field is blank, OR the total is non-positive/unpriceable
 * (§7), the quote shows the "contact us" state instead of a figure — while still
 * listing every parameter the visitor entered (FUNCTIONALITY §3.3: the actions
 * remain available regardless of completeness; empty fields are clearly shown).
 */
export function buildQuoteModel(params: {
  fields: PricingField[]
  formula: JsonLogic | null
  rawInputs: Record<string, RawInput>
  locale: string
  company: QuoteCompany
  text: QuoteText
  serviceTitle: string
  /** Injectable for deterministic tests; defaults to now. */
  now?: Date
}): QuoteModel {
  const { fields, formula, rawInputs, locale, company, text, serviceTitle } = params
  const now = params.now ?? new Date()

  const inputs = coerceInputs(fields, rawInputs)
  const result = computePrice({ fields, formula, inputs })

  const anyMissingRequired = fields.some((f) =>
    isMissingRequired(f, rawInputs[f.fieldKey]),
  )

  // Contributions are only meaningful for the default (non-formula) path, and
  // only in a real price state (they sum to the total) — same as the web page.
  const showContributions =
    !result.usedFormula &&
    result.kind === 'price' &&
    !anyMissingRequired &&
    result.lineItems.some((li) => li.contribution !== null)

  const lines: QuoteLine[] = fields.map((field) => {
    const li = result.lineItems.find((l) => l.fieldKey === field.fieldKey)
    return {
      label: field.label,
      valueDisplay: valueDisplay(field, rawInputs[field.fieldKey], text),
      contributionDisplay:
        showContributions && li && li.contribution !== null
          ? formatCurrency(li.contribution, locale)
          : null,
    }
  })

  const hasTotal = result.kind === 'price' && !anyMissingRequired

  return {
    locale,
    company,
    serviceTitle,
    dateDisplay: formatQuoteDate(now, locale),
    lines,
    hasTotal,
    totalDisplay:
      hasTotal && result.kind === 'price'
        ? formatCurrency(result.total, locale)
        : null,
    showContributions,
    text,
  }
}
