/**
 * A tiny, safe, arithmetic-only JSONLogic interpreter (Phase 3 — TECHSPEC §6.3/§6.4).
 *
 * Why in-house instead of `json-logic-js` / `json-logic-engine`?
 * -----------------------------------------------------------------------------
 * The pricing formula is stored as **standard JSONLogic** (a structured JSON AST,
 * never a string of executable code — the visual Formula Builder in Phase 3
 * part 2 emits exactly this shape). That format is portable and library-agnostic.
 *
 * The *evaluation* of it, however, is deliberately a ~50-line zero-dependency
 * function limited to the arithmetic operators a pricing engine needs:
 *   - `json-logic-js` is effectively unmaintained (no release in 12+ months),
 *     which works against this project's "stay current / periodic-maintenance-only"
 *     goal, and
 *   - `json-logic-engine` (its maintained successor) is a full general-purpose
 *     rules engine — more surface (and a supply-chain dependency the strict
 *     `npm audit --audit-level=high` CI gate would have to carry) than a closed,
 *     money-math domain warrants.
 *
 * Owning this tiny evaluator gives full, unit-tested control over the edge cases
 * that actually matter for pricing (division by zero, NaN/Infinity, the §7
 * non-positive-total rule), with zero new dependencies. Because the on-disk
 * format is standard JSONLogic, replacing this with `json-logic-engine` later is
 * a drop-in swap with **no data migration** — the stored formulas don't change.
 *
 * The same evaluator runs on the server (validation, the Phase 4 PDF) and the
 * client (the real-time calculator), so the two can never drift apart
 * (TECHSPEC §3 / §6.3).
 *
 * SAFETY: this never calls `eval`/`new Function`; it only reads from the supplied
 * data map and performs arithmetic. An unknown operator throws (callers treat a
 * throw as "can't price it" — see computePrice).
 */

/** A JSONLogic node: a primitive literal, an array of nodes, or a single-operator object. */
export type JsonLogic =
  | number
  | string
  | boolean
  | null
  | JsonLogic[]
  | { [operator: string]: JsonLogic }

/** The variable scope a formula is evaluated against (fieldKey → numeric value). */
export type LogicData = Record<string, number>

/** The arithmetic operators this evaluator supports. Intentionally closed. */
export const SUPPORTED_OPERATORS = [
  'var',
  '+',
  '-',
  '*',
  '/',
  'min',
  'max',
] as const

/** Coerce any evaluated value to a finite-or-NaN number (booleans → 1/0, null → 0). */
function num(value: unknown): number {
  if (typeof value === 'number') return value
  if (value === true) return 1
  if (value === false || value === null || value === undefined) return 0
  return Number(value)
}

function isPlainObject(v: unknown): v is Record<string, JsonLogic> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Evaluate a JSONLogic rule against `data`, returning a number.
 * Throws on an unsupported operator or a malformed rule.
 */
export function evaluateJsonLogic(rule: JsonLogic, data: LogicData): number {
  // Primitive literal.
  if (rule === null || typeof rule !== 'object') return num(rule)

  // A bare array evaluates element-wise to its last value is meaningless here;
  // arrays only appear as an operator's argument list, handled below. If one is
  // passed as a whole rule, treat it as a sum (harmless, never emitted by the
  // builder) — but be strict instead so malformed input is caught.
  if (Array.isArray(rule)) {
    throw new Error('jsonlogic: a bare array is not a valid rule')
  }

  const keys = Object.keys(rule)
  if (keys.length !== 1) {
    throw new Error(
      `jsonlogic: a rule object must have exactly one operator, got ${keys.length}`,
    )
  }
  const op = keys[0]
  const raw = (rule as Record<string, JsonLogic>)[op]
  const argList: JsonLogic[] = Array.isArray(raw) ? raw : [raw]

  // `var` reads from the data scope: {"var": "key"} or {"var": ["key", default]}.
  if (op === 'var') {
    const key = Array.isArray(raw) ? raw[0] : raw
    const fallback = Array.isArray(raw) && raw.length > 1 ? raw[1] : 0
    if (typeof key !== 'string') {
      throw new Error('jsonlogic: var name must be a string')
    }
    const found = data[key]
    return found === undefined || found === null
      ? num(evaluateJsonLogic(fallback, data))
      : num(found)
  }

  const args = argList.map((a) => evaluateJsonLogic(a, data))

  switch (op) {
    case '+':
      return args.reduce((sum, v) => sum + v, 0)
    case '*':
      return args.reduce((product, v) => product * v, 1)
    case '-':
      if (args.length === 0) return 0
      if (args.length === 1) return -args[0]
      return args.reduce((acc, v) => acc - v)
    case '/':
      // Division by zero yields ±Infinity; computePrice's finiteness check turns
      // that into the "Contact us for a price" state rather than showing "∞".
      return args[0] / args[1]
    case 'min':
      return Math.min(...args)
    case 'max':
      return Math.max(...args)
    default:
      throw new Error(`jsonlogic: unsupported operator "${op}"`)
  }
}

/** True if `formula` is a non-empty JSONLogic object worth evaluating. */
export function isUsableFormula(formula: unknown): formula is JsonLogic {
  if (Array.isArray(formula)) return formula.length > 0
  return isPlainObject(formula) && Object.keys(formula).length > 0
}
