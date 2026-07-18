/**
 * Shared pricing model + evaluator wrapper (Phase 3 — TECHSPEC §6.3, FUNCTIONALITY §3.3/§7).
 *
 * This is the single source of truth for turning a service's calculator fields +
 * visitor inputs (+ optional formula) into a price. It is a pure module — no
 * React, no next-intl, no DB — so it runs identically in the client calculator,
 * in server-side validation, and (Phase 4) in the PDF Lambda.
 *
 * Two ways a total is produced:
 *   1. **Default** (no custom formula): total = Σ of each field's signed
 *      contribution (unitPrice × value, negated when sign = 'subtract'). This
 *      matches the field-level model in FUNCTIONALITY §5.3 and covers the common
 *      case (e.g. "roof area × €/m² + panels × €/panel") with no formula to author.
 *   2. **Custom formula** (JSONLogic present): the stored formula is authoritative
 *      and evaluated against the raw field values. Fixed costs, percentage
 *      adjustments and groupings live here (FUNCTIONALITY §5.3 Formula Builder).
 *
 * The §7 edge case — a zero/negative/undefined total — resolves to
 * `{ kind: 'contact' }` so the UI shows "Contact us for a price" instead of a
 * number, on both the web page and the PDF.
 */

import {
  evaluateJsonLogic,
  isUsableFormula,
  type JsonLogic,
  type LogicData,
} from './jsonlogic'

export { isUsableFormula }
export type { JsonLogic, LogicData }

export type PricingFieldType = 'number' | 'dropdown' | 'toggle'

export interface PricingOption {
  label: string
  value: number
}

/**
 * A client-safe projection of a `Services.calculatorFields` entry: plain strings
 * and numbers only (no Lexical/rich objects), locale-resolved labels. The server
 * page maps Payload's field shape into this before handing it to the client
 * calculator — the same "map to a lightweight card on the server" pattern used by
 * ProjectsBrowser.
 */
export interface PricingField {
  fieldKey: string
  label: string
  type: PricingFieldType
  options: PricingOption[]
  unitPrice: number | null
  sign: 'add' | 'subtract'
  required: boolean
}

/** One row in the estimate breakdown (FUNCTIONALITY §4 line items). */
export interface LineItem {
  fieldKey: string
  label: string
  value: number
  /** signed unitPrice × value, or null when the field has no unitPrice. */
  contribution: number | null
}

export type PriceResult =
  | { kind: 'price'; total: number; usedFormula: boolean; lineItems: LineItem[] }
  | { kind: 'contact'; usedFormula: boolean; lineItems: LineItem[] }

/** A raw value straight from a form control, before coercion to a number. */
export type RawInput = string | number | boolean | null | undefined

/**
 * The loose shape of a Payload `calculatorFields` entry (a subset of the
 * generated type — enough to project into a PricingField). Kept structural so
 * callers can pass `service.calculatorFields` directly.
 */
interface RawCalculatorField {
  fieldKey?: string | null
  label?: string | null
  type?: PricingFieldType | null
  options?: ({ optionLabel?: string | null; value?: number | null } | null)[] | null
  unitPrice?: number | null
  sign?: ('add' | 'subtract') | null
  required?: boolean | null
}

/** Project Payload's calculatorFields into the client-safe PricingField[]. */
export function toPricingFields(
  fields: RawCalculatorField[] | null | undefined,
): PricingField[] {
  if (!fields) return []
  return fields
    .filter((f): f is RawCalculatorField => !!f && !!f.fieldKey)
    .map((f) => ({
      fieldKey: f.fieldKey as string,
      label: f.label ?? (f.fieldKey as string),
      type: (f.type ?? 'number') as PricingFieldType,
      options: (f.options ?? [])
        .filter((o): o is { optionLabel?: string | null; value?: number | null } => !!o)
        .map((o) => ({
          label: o.optionLabel ?? '',
          value: typeof o.value === 'number' ? o.value : Number(o.value) || 0,
        })),
      unitPrice:
        f.unitPrice === null || f.unitPrice === undefined ? null : Number(f.unitPrice),
      sign: f.sign === 'subtract' ? 'subtract' : 'add',
      required: !!f.required,
    }))
}

/** Coerce one raw form value to the numeric value the formula/pricing uses. */
export function coerceFieldValue(field: PricingField, raw: RawInput): number {
  if (field.type === 'toggle') {
    return raw === true || raw === 'true' || raw === 'on' || raw === 1 ? 1 : 0
  }
  // number + dropdown: a numeric string/number; blank or invalid → 0.
  if (raw === '' || raw === null || raw === undefined) return 0
  const n = Number(raw)
  return Number.isFinite(n) ? n : 0
}

/** Coerce a whole raw-input map into the numeric scope a formula evaluates against. */
export function coerceInputs(
  fields: PricingField[],
  raw: Record<string, RawInput>,
): LogicData {
  const out: LogicData = {}
  for (const field of fields) {
    out[field.fieldKey] = coerceFieldValue(field, raw[field.fieldKey])
  }
  return out
}

/** Signed contribution of a single field, or null when it has no unitPrice. */
export function fieldContribution(field: PricingField, value: number): number | null {
  if (field.unitPrice === null || field.unitPrice === undefined) return null
  const signed = field.sign === 'subtract' ? -1 : 1
  return signed * field.unitPrice * value
}

/** Round to 2 decimals, guarding the classic 0.1 + 0.2 float error. */
function roundMoney(x: number): number {
  return Math.round((x + Number.EPSILON) * 100) / 100
}

/**
 * The core: compute a price from fields, an optional formula, and coerced inputs.
 * Never throws — a malformed/unsupported formula resolves to `kind: 'contact'`.
 */
export function computePrice(params: {
  fields: PricingField[]
  formula?: JsonLogic | null
  inputs: LogicData
}): PriceResult {
  const { fields, formula, inputs } = params

  const lineItems: LineItem[] = fields.map((f) => {
    const value = inputs[f.fieldKey] ?? 0
    return {
      fieldKey: f.fieldKey,
      label: f.label,
      value,
      contribution: fieldContribution(f, value),
    }
  })

  const usedFormula = isUsableFormula(formula)

  let total: number
  if (usedFormula) {
    try {
      total = evaluateJsonLogic(formula as JsonLogic, inputs)
    } catch {
      return { kind: 'contact', usedFormula, lineItems }
    }
  } else {
    total = lineItems.reduce((sum, li) => sum + (li.contribution ?? 0), 0)
  }

  total = roundMoney(total)

  // §7: a non-positive or non-finite total → "Contact us for a price".
  if (!Number.isFinite(total) || total <= 0) {
    return { kind: 'contact', usedFormula, lineItems }
  }
  return { kind: 'price', total, usedFormula, lineItems }
}

/** Locale-aware EUR formatting (Luxembourg). */
export function formatCurrency(amount: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 2,
  }).format(amount)
}
