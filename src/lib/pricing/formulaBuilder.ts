/**
 * Structured Formula Builder model + JSONLogic compiler/parser
 * (Phase 3 part 2 — TECHSPEC §6.4, FUNCTIONALITY §5.3).
 *
 * The visual Formula Builder in the admin lets a non-technical operator assemble
 * a pricing formula without writing code. This module is the PURE core of that
 * feature: it defines the structured builder model and the two conversions
 *
 *   compileFormula(model)  →  JSONLogic          (what is stored + evaluated)
 *   parseFormula(jsonlogic) →  model | null        (reconstruct the UI on load)
 *
 * It has no React / DOM / Payload imports, so it is unit-testable in-sandbox and
 * shared verbatim by the admin component and the tests.
 *
 * WHY the stored value stays plain JSONLogic (not the builder model):
 * -----------------------------------------------------------------------------
 * The `formula` field is already read as JSONLogic by the shared evaluator
 * (`src/lib/pricing/`), by the public live calculator, and (Phase 4) by the PDF.
 * Storing the builder's own model there would break all three and force a data
 * migration. So the builder is a *view* over canonical JSONLogic: it compiles to
 * JSONLogic on every edit and parses JSONLogic back into the model on load. Any
 * formula the builder can produce round-trips losslessly; anything hand-authored
 * outside the builder's canonical shape is detected (`parseFormula` returns
 * `null`) and the component falls back to a raw-JSON editor — nothing is ever
 * locked out.
 *
 * Canonical compiled shape (the inverse of which `parseFormula` recognises):
 *
 *   total = adjustment( … adjustment( subtotal ) … )
 *   subtotal        = { "+": [ term, term, … ] }
 *   term (field)    = { "*": [ { "var": key }, ±multiplier ] }
 *   term (fixed)    = ±amount
 *   term (group)    = { "*": [ { "+": [ member, … ] }, factor (,-1) ] }
 *   member (field)  = { "*": [ { "var": key }, multiplier ] }
 *   member (fixed)  = amount
 *   adjustment(x)   = { "*": [ x, 1 + percent/100 ] }   // VAT / discount
 *
 * Only the arithmetic operators the evaluator supports (`var`, `+`, `*`) are ever
 * emitted; `min`/`max`/`-`/`/` remain available to raw-JSON authors and the
 * evaluator, they are simply not surfaced by the visual builder (kept intentionally
 * focused on the FUNCTIONALITY §5.3 requirements: fields, fixed costs, groupings,
 * percentage adjustments).
 */

import type { JsonLogic } from './jsonlogic'

export type Sign = 'add' | 'subtract'

/** A single member inside a group (one level deep — no nested groups). */
export type GroupMember =
  | { kind: 'field'; fieldKey: string; multiplier: number }
  | { kind: 'fixed'; amount: number }

/** A top-level term contributing to the subtotal. */
export type BuilderTerm =
  | { kind: 'field'; sign: Sign; fieldKey: string; multiplier: number }
  | { kind: 'fixed'; sign: Sign; amount: number }
  | {
      kind: 'group'
      sign: Sign
      members: GroupMember[]
      factorType: 'constant' | 'field'
      factorConstant: number
      factorField: string
    }

/** A percentage adjustment applied, in order, to the running subtotal. */
export interface BuilderAdjustment {
  sign: Sign
  /** e.g. 10 for "+10% VAT" or "−10% discount". */
  percent: number
  /** Free-text label shown in the UI (e.g. "VAT"); not compiled into JSONLogic. */
  label: string
}

export interface BuilderFormula {
  terms: BuilderTerm[]
  adjustments: BuilderAdjustment[]
}

export const emptyFormula = (): BuilderFormula => ({ terms: [], adjustments: [] })

/** Numbers coming out of arithmetic can carry float dust; tidy to 6 dp. */
function tidy(n: number): number {
  return Math.round((n + Number.EPSILON) * 1e6) / 1e6
}

function isObj(v: unknown): v is Record<string, JsonLogic> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** A single-operator node `{ op: args }` → `[op, args]`, else null. */
function asOp(node: JsonLogic): [string, JsonLogic] | null {
  if (!isObj(node)) return null
  const keys = Object.keys(node)
  if (keys.length !== 1) return null
  return [keys[0], node[keys[0]]]
}

// ---------------------------------------------------------------------------
// Compile: BuilderFormula → JSONLogic
// ---------------------------------------------------------------------------

function compileMember(m: GroupMember): JsonLogic {
  if (m.kind === 'fixed') return tidy(m.amount)
  return { '*': [{ var: m.fieldKey }, tidy(m.multiplier)] }
}

function compileTerm(t: BuilderTerm): JsonLogic {
  const neg = t.sign === 'subtract'
  if (t.kind === 'fixed') return tidy(neg ? -t.amount : t.amount)
  if (t.kind === 'field') {
    const m = neg ? -t.multiplier : t.multiplier
    return { '*': [{ var: t.fieldKey }, tidy(m)] }
  }
  // group
  const inner: JsonLogic = { '+': t.members.map(compileMember) }
  const factor: JsonLogic =
    t.factorType === 'field' ? { var: t.factorField } : tidy(t.factorConstant)
  const args: JsonLogic[] = [inner, factor]
  if (neg) args.push(-1)
  return { '*': args }
}

/**
 * Compile the builder model to a JSONLogic rule, or `null` when the model is
 * effectively empty (no terms) — the caller stores `null`/undefined so the
 * pricing engine falls back to its default per-field summation path.
 */
export function compileFormula(model: BuilderFormula): JsonLogic | null {
  const terms = model.terms ?? []
  if (terms.length === 0) return null

  let node: JsonLogic = { '+': terms.map(compileTerm) }

  for (const adj of model.adjustments ?? []) {
    if (!adj || !Number.isFinite(adj.percent) || adj.percent === 0) continue
    const signed = adj.sign === 'subtract' ? -adj.percent : adj.percent
    const factor = tidy(1 + signed / 100)
    node = { '*': [node, factor] }
  }
  return node
}

// ---------------------------------------------------------------------------
// Parse: JSONLogic → BuilderFormula | null
// ---------------------------------------------------------------------------

function parseFieldFactorProduct(
  args: JsonLogic[],
): { fieldKey: string; multiplier: number } | null {
  if (args.length !== 2) return null
  let varNode: [string, JsonLogic] | null = null
  let mult: number | null = null
  for (const a of args) {
    const op = asOp(a)
    if (op && op[0] === 'var' && typeof op[1] === 'string') varNode = op
    else if (typeof a === 'number') mult = a
  }
  if (!varNode || mult === null) return null
  return { fieldKey: varNode[1] as string, multiplier: mult }
}

function parseMember(node: JsonLogic): GroupMember | null {
  if (typeof node === 'number') return { kind: 'fixed', amount: node }
  const op = asOp(node)
  if (!op) return null
  if (op[0] === 'var' && typeof op[1] === 'string') {
    return { kind: 'field', fieldKey: op[1], multiplier: 1 }
  }
  if (op[0] === '*' && Array.isArray(op[1])) {
    const fp = parseFieldFactorProduct(op[1])
    if (fp) return { kind: 'field', fieldKey: fp.fieldKey, multiplier: fp.multiplier }
  }
  return null
}

function parseGroup(args: JsonLogic[]): BuilderTerm | null {
  let inner: JsonLogic[] | null = null
  let factorConstant: number | null = null
  let factorField: string | null = null
  let neg = false

  for (const a of args) {
    if (typeof a === 'number') {
      if (a === -1 && !neg) {
        neg = true
      } else {
        factorConstant = a
      }
      continue
    }
    const op = asOp(a)
    if (!op) return null
    if (op[0] === '+' && Array.isArray(op[1])) inner = op[1]
    else if (op[0] === 'var' && typeof op[1] === 'string') factorField = op[1]
    else return null
  }

  if (!inner) return null
  const members: GroupMember[] = []
  for (const mNode of inner) {
    const m = parseMember(mNode)
    if (!m) return null
    members.push(m)
  }

  const sign: Sign = neg ? 'subtract' : 'add'
  if (factorField !== null) {
    return {
      kind: 'group',
      sign,
      members,
      factorType: 'field',
      factorConstant: 1,
      factorField,
    }
  }
  return {
    kind: 'group',
    sign,
    members,
    factorType: 'constant',
    factorConstant: factorConstant === null ? 1 : factorConstant,
    factorField: '',
  }
}

function parseTerm(node: JsonLogic): BuilderTerm | null {
  if (typeof node === 'number') {
    return node < 0
      ? { kind: 'fixed', sign: 'subtract', amount: -node }
      : { kind: 'fixed', sign: 'add', amount: node }
  }
  const op = asOp(node)
  if (!op) return null

  if (op[0] === 'var' && typeof op[1] === 'string') {
    return { kind: 'field', sign: 'add', fieldKey: op[1], multiplier: 1 }
  }

  if (op[0] === '*' && Array.isArray(op[1])) {
    const args = op[1]
    // Field term: exactly { var } × number.
    const fp = parseFieldFactorProduct(args)
    if (fp) {
      const neg = fp.multiplier < 0
      return {
        kind: 'field',
        sign: neg ? 'subtract' : 'add',
        fieldKey: fp.fieldKey,
        multiplier: Math.abs(fp.multiplier),
      }
    }
    // Otherwise a group: must contain a `{ "+": [...] }` inner node.
    if (args.some((a) => asOp(a)?.[0] === '+')) return parseGroup(args)
  }
  return null
}

/**
 * Reconstruct the builder model from stored JSONLogic. Returns `null` when the
 * rule is not in the builder's canonical shape (e.g. hand-authored raw JSON or
 * uses operators/nesting the visual builder can't represent) — the component
 * then shows the raw-JSON editor instead.
 */
export function parseFormula(rule: unknown): BuilderFormula | null {
  if (rule === null || rule === undefined) return emptyFormula()
  // Empty object / array ⇒ no formula.
  if (isObj(rule) && Object.keys(rule).length === 0) return emptyFormula()

  let node = rule as JsonLogic
  const adjustments: BuilderAdjustment[] = []

  // Peel percentage adjustments: { "*": [ inner, factorNumber ] } wrapping a
  // subtotal/adjustment node. The outermost is the last-applied, so we reverse.
  let guard = 0
  while (guard++ < 100) {
    const op = asOp(node)
    if (!op || op[0] !== '*' || !Array.isArray(op[1]) || op[1].length !== 2) break
    const [a, b] = op[1]
    const child = isObj(a) ? a : isObj(b) ? b : null
    const factor = typeof a === 'number' ? a : typeof b === 'number' ? b : null
    if (child === null || factor === null) break
    const childOp = asOp(child)
    // Only treat as an adjustment when the child is itself a subtotal (`+`) or a
    // further adjustment (`*`). A field term ({var}×n) must NOT be peeled.
    if (!childOp || (childOp[0] !== '+' && childOp[0] !== '*')) break
    const percent = tidy((factor - 1) * 100)
    adjustments.push({
      sign: percent < 0 ? 'subtract' : 'add',
      percent: Math.abs(percent),
      label: '',
    })
    node = child
  }
  adjustments.reverse()

  // The remaining node is the subtotal.
  const termNodes: JsonLogic[] = (() => {
    const op = asOp(node)
    if (op && op[0] === '+' && Array.isArray(op[1])) return op[1]
    return [node] // a single-term subtotal
  })()

  const terms: BuilderTerm[] = []
  for (const tNode of termNodes) {
    const t = parseTerm(tNode)
    if (!t) return null // not builder-canonical → caller uses raw JSON
    terms.push(t)
  }

  return { terms, adjustments }
}
