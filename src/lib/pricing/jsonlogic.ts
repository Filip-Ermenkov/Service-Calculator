/**
 * A tiny, safe, numeric JSONLogic interpreter (Phase 3 — TECHSPEC §6.3/§6.4).
 *
 * Why in-house instead of `json-logic-js` / `json-logic-engine`?
 * -----------------------------------------------------------------------------
 * The pricing formula is stored as **standard JSONLogic** (a structured JSON AST,
 * never a string of executable code — the admin's Formula editor compiles to
 * exactly this shape, see ./formulaExpression.ts). That format is portable and
 * library-agnostic.
 *
 * The *evaluation* of it, however, is deliberately a small zero-dependency
 * function limited to the operators a pricing engine needs:
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
 * Operator set (2026-09-14, "any formula you want" — FUNCTIONALITY §5.3):
 *   arithmetic  `+ - * / %`, `min`, `max`
 *   comparison  `== != < <= > >=` (2 args; `<`/`<=`/`>`/`>=` also take the
 *               standard 3-arg "between" form), returning 1 / 0
 *   logic       `and`, `or` (standard short-circuit value semantics), `!`, `!!`
 *   branching   `if` (condition, then, [elseif-condition, then]…, else) — lazy
 *   rounding    `round` (`[x]` or `[x, decimals]`), `ceil`, `floor`, `abs`
 * The rounding four are NOT part of the JSONLogic standard — they are the one
 * documented extension (whole panels, whole hours, "round to the nearest €10"
 * are real pricing needs). If this evaluator is ever swapped for
 * `json-logic-engine`, register them there as custom operations.
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

/** The operators this evaluator supports. Intentionally closed. */
export const SUPPORTED_OPERATORS = [
  'var',
  '+',
  '-',
  '*',
  '/',
  '%',
  'min',
  'max',
  '==',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  'and',
  'or',
  '!',
  '!!',
  'if',
  'round',
  'ceil',
  'floor',
  'abs',
] as const

export type SupportedOperator = (typeof SUPPORTED_OPERATORS)[number]

const SUPPORTED = new Set<string>(SUPPORTED_OPERATORS)

export function isSupportedOperator(op: string): op is SupportedOperator {
  return SUPPORTED.has(op)
}

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

/** JSONLogic truthiness on the numeric domain: 0 and NaN are false. */
function truthy(n: number): boolean {
  return n !== 0 && !Number.isNaN(n)
}

function requireArity(op: string, args: unknown[], min: number, max = Infinity): void {
  if (args.length < min || args.length > max) {
    throw new Error(`jsonlogic: "${op}" expects ${min}${max === min ? '' : max === Infinity ? '+' : `–${max}`} argument(s), got ${args.length}`)
  }
}

/** Round half away from zero at `decimals` places, guarding float dust (0.1 + 0.2). */
function roundTo(x: number, decimals: number): number {
  const d = Math.max(0, Math.min(10, Math.trunc(decimals)))
  const factor = 10 ** d
  // EPSILON is added BEFORE scaling — at 100.4999… it would be far below the
  // float's own resolution and change nothing (the 1.005 → 1.01 case).
  return Math.sign(x) * (Math.round((Math.abs(x) + Number.EPSILON) * factor) / factor)
}

/**
 * Evaluate a JSONLogic rule against `data`, returning a number.
 * Throws on an unsupported operator or a malformed rule.
 */
export function evaluateJsonLogic(rule: JsonLogic, data: LogicData): number {
  // Primitive literal.
  if (rule === null || typeof rule !== 'object') return num(rule)

  // Arrays only appear as an operator's argument list, handled below. A bare
  // array as a whole rule is malformed — be strict so bad input is caught.
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

  // `if` is lazy: only the branch that is taken gets evaluated, so a division
  // by zero (or a not-yet-valid sub-formula) in the OTHER branch can't leak in.
  if (op === 'if') {
    requireArity(op, argList, 2)
    let i = 0
    while (i + 1 < argList.length) {
      if (truthy(evaluateJsonLogic(argList[i], data))) {
        return evaluateJsonLogic(argList[i + 1], data)
      }
      i += 2
    }
    // Trailing "else" value, or 0 when the chain has none (standard: null → 0).
    return i < argList.length ? evaluateJsonLogic(argList[i], data) : 0
  }

  if (!isSupportedOperator(op)) {
    throw new Error(`jsonlogic: unsupported operator "${op}"`)
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
      requireArity(op, args, 2, 2)
      return args[0] / args[1]
    case '%':
      requireArity(op, args, 2, 2)
      return args[0] % args[1]
    case 'min':
      requireArity(op, args, 1)
      return Math.min(...args)
    case 'max':
      requireArity(op, args, 1)
      return Math.max(...args)
    case '==':
      requireArity(op, args, 2, 2)
      return args[0] === args[1] ? 1 : 0
    case '!=':
      requireArity(op, args, 2, 2)
      return args[0] !== args[1] ? 1 : 0
    case '<':
      requireArity(op, args, 2, 3)
      return args[0] < args[1] && (args.length === 2 || args[1] < args[2]) ? 1 : 0
    case '<=':
      requireArity(op, args, 2, 3)
      return args[0] <= args[1] && (args.length === 2 || args[1] <= args[2]) ? 1 : 0
    case '>':
      requireArity(op, args, 2, 3)
      return args[0] > args[1] && (args.length === 2 || args[1] > args[2]) ? 1 : 0
    case '>=':
      requireArity(op, args, 2, 3)
      return args[0] >= args[1] && (args.length === 2 || args[1] >= args[2]) ? 1 : 0
    case 'and': {
      // Standard JSONLogic: the first falsy argument, else the last one.
      requireArity(op, args, 1)
      for (const v of args) if (!truthy(v)) return v
      return args[args.length - 1]
    }
    case 'or': {
      // Standard JSONLogic: the first truthy argument, else the last one.
      requireArity(op, args, 1)
      for (const v of args) if (truthy(v)) return v
      return args[args.length - 1]
    }
    case '!':
      requireArity(op, args, 1, 1)
      return truthy(args[0]) ? 0 : 1
    case '!!':
      requireArity(op, args, 1, 1)
      return truthy(args[0]) ? 1 : 0
    case 'round':
      requireArity(op, args, 1, 2)
      return roundTo(args[0], args.length > 1 ? args[1] : 0)
    case 'ceil':
      requireArity(op, args, 1, 1)
      return Math.ceil(args[0])
    case 'floor':
      requireArity(op, args, 1, 1)
      return Math.floor(args[0])
    case 'abs':
      requireArity(op, args, 1, 1)
      return Math.abs(args[0])
    default:
      throw new Error(`jsonlogic: unsupported operator "${op as string}"`)
  }
}

/** True if `formula` is a non-empty JSONLogic object worth evaluating. */
export function isUsableFormula(formula: unknown): formula is JsonLogic {
  if (Array.isArray(formula)) return formula.length > 0
  return isPlainObject(formula) && Object.keys(formula).length > 0
}
