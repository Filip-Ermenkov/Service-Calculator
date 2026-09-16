/**
 * Price-formula expression language — the pure core of the admin Formula editor
 * (TECHSPEC §6.4, FUNCTIONALITY §5.3; rebuilt 2026-09-14).
 *
 * The admin types (or click-inserts) an ordinary arithmetic expression such as
 *
 *     (area × rate + 200) × (1 + 17%)
 *     if(area > 100, area × 10, area × 12)
 *     ceil(area / 1.7) × 250 + max(hours, 2) × 65
 *
 * and this module converts it both ways:
 *
 *     compileExpression(text, fields)  →  JSONLogic  (what is stored + evaluated)
 *     printFormula(jsonlogic)          →  text       (to re-open a stored formula)
 *
 * WHY a text expression rather than the earlier structured "terms" builder:
 * a fixed catalogue of term shapes (field × number, fixed cost, one-level group)
 * can never express "whatever formula I want" — field × field needed a group
 * workaround, tiers/caps/rounding were impossible. An expression with ordinary
 * precedence and brackets is the model every spreadsheet user already knows, and
 * it is what no-code tools (Airtable, Notion, Coda) converged on: a formula bar
 * with highlighting, autocomplete, plain-language errors and inline docs.
 *
 * WHY the stored value stays plain JSONLogic (not the text):
 * the `formula` field is read as JSONLogic by the shared evaluator
 * (`./jsonlogic.ts`), the public live calculator and the PDF quote. The
 * expression is a *view* over that canonical AST: it compiles on every edit and
 * prints back on load, so nothing downstream changes and no migration is
 * needed. Printing normalises presentation only (`*` → `×`, `17%` → `0.17`,
 * redundant brackets dropped) — the arithmetic is preserved exactly.
 *
 * Draft marker: an expression that does not parse cannot become JSONLogic, yet
 * the admin must not lose their half-typed text (nor silently keep publishing a
 * stale formula). The editor therefore stores `{ "__draft": "<text>" }` while
 * the text is invalid; `validateStoredFormula` (wired as the field's Payload
 * `validate`) rejects that marker — and any JSONLogic the evaluator can't run —
 * so an invalid formula can never be published. The evaluator itself treats the
 * marker as an unknown operator (→ "Contact us for a price"), a safe fallback
 * for an unvalidated draft save.
 *
 * Grammar (lowest to highest precedence; all binary operators left-associative):
 *
 *     or        →  and ( "or" and )*
 *     and       →  not ( "and" not )*
 *     not       →  "not" not | comparison
 *     comparison→  sum ( ( "<" | "<=" | ">" | ">=" | "=" | "!=" ) sum )?
 *     sum       →  product ( ( "+" | "-" ) product )*
 *     product   →  unary ( ( "*" | "/" ) unary )*
 *     unary     →  ( "-" | "+" ) unary | postfix
 *     postfix   →  primary ( "%" )*                       17% ≡ 0.17
 *     primary   →  number | field | "(" or ")" | function "(" args ")"
 *
 * Field references are the calculator fields' `fieldKey`s, written bare when
 * identifier-shaped (`roof_area`) or in braces otherwise (`{roof area}`). The
 * typographic forms `× ÷ − ≠ ≤ ≥` are accepted alongside `* / - != <= >=`, and
 * `;` alongside `,` between function arguments (European keyboards/habits).
 *
 * No React / DOM / Payload imports: shared verbatim by the admin component, the
 * server-side field validation, and the unit tests.
 */

import { isSupportedOperator, type JsonLogic } from './jsonlogic'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The subset of a calculator field the language needs (key + display label). */
export interface FormulaFieldRef {
  fieldKey: string
  label?: string | null
}

/** A problem in the source text, with the character range to underline. */
export interface ExpressionError {
  message: string
  /** Offset of the first offending character. */
  start: number
  /** Offset just past the last offending character (≥ start; equal ⇒ a caret). */
  end: number
}

export type HighlightKind =
  | 'number'
  | 'field'
  | 'unknown'
  | 'keyword'
  | 'function'
  | 'operator'
  | 'paren'
  | 'comma'
  | 'percent'
  | 'invalid'

/** A classified span of the source text, for syntax highlighting. */
export interface HighlightToken {
  kind: HighlightKind
  text: string
  start: number
  end: number
  /** Resolved `fieldKey` for `field` tokens. */
  key?: string
  /** Bracket nesting depth for `paren` tokens (0-based), for pair matching. */
  depth?: number
}

/** Metadata for the functions the language offers (palette + reference panel). */
export interface FormulaFunctionInfo {
  name: FunctionName
  /** Human signature, e.g. "if(condition, value if true, value if false)". */
  signature: string
  description: string
  example: string
  /** What the palette inserts; `|` marks where the caret should land. */
  insert: string
}

export type FunctionName = 'if' | 'min' | 'max' | 'round' | 'ceil' | 'floor' | 'abs' | 'mod'

export const FORMULA_FUNCTIONS: readonly FormulaFunctionInfo[] = [
  {
    name: 'if',
    signature: 'if(condition, value if true, value if false)',
    description:
      'Chooses between two values. Conditions compare with < > ≤ ≥ = ≠ and can be combined with "and" / "or".',
    example: 'if(area > 100, area × 10, area × 12)',
    insert: 'if(|, , )',
  },
  {
    name: 'min',
    signature: 'min(a, b, …)',
    description: 'The smallest of the values — a ceiling: min(total, 5000) never exceeds 5000.',
    example: 'min(area × 12, 5000)',
    insert: 'min(|, )',
  },
  {
    name: 'max',
    signature: 'max(a, b, …)',
    description: 'The largest of the values — a floor / minimum charge: max(hours, 2) bills at least 2.',
    example: 'max(hours, 2) × 65',
    insert: 'max(|, )',
  },
  {
    name: 'round',
    signature: 'round(value) or round(value, decimals)',
    description: 'Rounds to the nearest whole number, or to the given number of decimals.',
    example: 'round(area × 1.7)',
    insert: 'round(|)',
  },
  {
    name: 'ceil',
    signature: 'ceil(value)',
    description: 'Rounds UP to the next whole number — whole panels, whole hours, whole trips.',
    example: 'ceil(area / 1.7) × 250',
    insert: 'ceil(|)',
  },
  {
    name: 'floor',
    signature: 'floor(value)',
    description: 'Rounds DOWN to the previous whole number.',
    example: 'floor(hours) × 65',
    insert: 'floor(|)',
  },
  {
    name: 'abs',
    signature: 'abs(value)',
    description: 'The value without its sign (a negative becomes positive).',
    example: 'abs(target − actual) × 3',
    insert: 'abs(|)',
  },
  {
    name: 'mod',
    signature: 'mod(a, b)',
    description: 'The remainder after dividing a by b.',
    example: 'mod(panels, 4)',
    insert: 'mod(|, )',
  },
]

const FUNCTION_NAMES = new Set<string>(FORMULA_FUNCTIONS.map((f) => f.name))
const KEYWORDS = new Set(['and', 'or', 'not'])

/** Words that cannot be used bare as field references (write them in braces). */
export function isReservedWord(word: string): boolean {
  const w = word.toLowerCase()
  return KEYWORDS.has(w) || FUNCTION_NAMES.has(w)
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Sym = '+' | '-' | '*' | '/' | '%' | '(' | ')' | ',' | '<' | '<=' | '>' | '>=' | '==' | '!='

type RawToken =
  | { kind: 'num'; value: number; start: number; end: number }
  | { kind: 'ident'; name: string; braced: boolean; start: number; end: number }
  | { kind: 'sym'; sym: Sym; start: number; end: number }
  | { kind: 'bad'; message: string; start: number; end: number }
  | { kind: 'end'; start: number; end: number }

const IDENT_START = /[\p{L}_]/u
const IDENT_PART = /[\p{L}\p{N}_]/u
const IDENT_RE = /^[\p{L}_][\p{L}\p{N}_]*$/u

/** Display form of a symbol in error messages (`*` reads as `×`, etc.). */
const SYM_DISPLAY: Record<Sym, string> = {
  '+': '+',
  '-': '−',
  '*': '×',
  '/': '÷',
  '%': '%',
  '(': '(',
  ')': ')',
  ',': ',',
  '<': '<',
  '<=': '≤',
  '>': '>',
  '>=': '≥',
  '==': '=',
  '!=': '≠',
}

// Two-character symbols first, then one-character ones (incl. typographic forms).
const TWO_CHAR: Record<string, Sym> = { '<=': '<=', '>=': '>=', '==': '==', '!=': '!=', '<>': '!=' }
const ONE_CHAR: Record<string, Sym> = {
  '+': '+',
  '-': '-',
  '−': '-',
  '–': '-',
  '*': '*',
  '×': '*',
  '·': '*',
  '/': '/',
  '÷': '/',
  '%': '%',
  '(': '(',
  ')': ')',
  ',': ',',
  ';': ',',
  '<': '<',
  '>': '>',
  '=': '==',
  '≠': '!=',
  '≤': '<=',
  '≥': '>=',
}

/** Tolerant tokenizer: never throws — bad characters become `bad` tokens. */
function tokenize(text: string): RawToken[] {
  const out: RawToken[] = []
  let i = 0
  const n = text.length

  while (i < n) {
    const ch = text[i]

    if (/\s/u.test(ch)) {
      i++
      continue
    }

    // Number: 12, 1.5, .5
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(text[i + 1] ?? ''))) {
      const m = /^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)/.exec(text.slice(i))!
      const raw = m[0]
      out.push({ kind: 'num', value: Number(raw), start: i, end: i + raw.length })
      i += raw.length
      continue
    }

    // Identifier: field key, function or keyword.
    if (IDENT_START.test(ch)) {
      let j = i + 1
      while (j < n && IDENT_PART.test(text[j])) j++
      out.push({ kind: 'ident', name: text.slice(i, j), braced: false, start: i, end: j })
      i = j
      continue
    }

    // Braced field reference: {any key}
    if (ch === '{') {
      const close = text.indexOf('}', i + 1)
      if (close === -1) {
        out.push({ kind: 'bad', message: 'Missing the closing } of a field name.', start: i, end: n })
        i = n
        continue
      }
      const name = text.slice(i + 1, close).trim()
      if (name === '') {
        out.push({ kind: 'bad', message: 'Empty field name — write the field key between the braces.', start: i, end: close + 1 })
      } else {
        out.push({ kind: 'ident', name, braced: true, start: i, end: close + 1 })
      }
      i = close + 1
      continue
    }

    const two = TWO_CHAR[text.slice(i, i + 2)]
    if (two) {
      out.push({ kind: 'sym', sym: two, start: i, end: i + 2 })
      i += 2
      continue
    }
    const one = ONE_CHAR[ch]
    if (one) {
      out.push({ kind: 'sym', sym: one, start: i, end: i + 1 })
      i += 1
      continue
    }

    // Anything else is a mistake — say what, in plain words.
    let message = `Unexpected character "${ch}".`
    if (ch === '^') message = 'Powers (^) are not supported — multiply the value by itself instead.'
    else if (ch === '"' || ch === "'" || ch === '“' || ch === '”') message = 'Text values are not supported in a price formula — a formula only works with numbers and fields.'
    else if (ch === '[' || ch === ']') message = 'Use round brackets ( ) to group calculations.'
    else if (ch === '}') message = 'Unexpected } — field names in braces must start with {.'
    else if (ch === '€' || ch === '$' || ch === '£') message = `Leave out the currency sign — write the amount as a plain number.`
    out.push({ kind: 'bad', message, start: i, end: i + 1 })
    i += 1
  }

  out.push({ kind: 'end', start: n, end: n })
  return out
}

// ---------------------------------------------------------------------------
// Highlighting
// ---------------------------------------------------------------------------

/**
 * Classify the source text into spans for syntax highlighting. Tolerant of
 * errors (an unparsable formula still highlights what it can). Bracket tokens
 * carry their nesting depth so the editor can highlight the matching pair.
 */
export function highlightTokens(text: string, fields: FormulaFieldRef[]): HighlightToken[] {
  const keys = new Set(fields.map((f) => f.fieldKey))
  const out: HighlightToken[] = []
  let depth = 0
  for (const t of tokenize(text)) {
    if (t.kind === 'end') break
    const slice = text.slice(t.start, t.end)
    if (t.kind === 'num') {
      out.push({ kind: 'number', text: slice, start: t.start, end: t.end })
    } else if (t.kind === 'ident') {
      if (!t.braced && KEYWORDS.has(t.name.toLowerCase())) {
        out.push({ kind: 'keyword', text: slice, start: t.start, end: t.end })
      } else if (!t.braced && FUNCTION_NAMES.has(t.name.toLowerCase())) {
        out.push({ kind: 'function', text: slice, start: t.start, end: t.end })
      } else if (keys.has(t.name)) {
        out.push({ kind: 'field', text: slice, start: t.start, end: t.end, key: t.name })
      } else {
        out.push({ kind: 'unknown', text: slice, start: t.start, end: t.end })
      }
    } else if (t.kind === 'sym') {
      if (t.sym === '(') {
        out.push({ kind: 'paren', text: slice, start: t.start, end: t.end, depth })
        depth++
      } else if (t.sym === ')') {
        depth = Math.max(0, depth - 1)
        out.push({ kind: 'paren', text: slice, start: t.start, end: t.end, depth })
      } else if (t.sym === ',') {
        out.push({ kind: 'comma', text: slice, start: t.start, end: t.end })
      } else if (t.sym === '%') {
        out.push({ kind: 'percent', text: slice, start: t.start, end: t.end })
      } else {
        out.push({ kind: 'operator', text: slice, start: t.start, end: t.end })
      }
    } else {
      out.push({ kind: 'invalid', text: slice, start: t.start, end: t.end })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Parser → JSONLogic
// ---------------------------------------------------------------------------

class ParseError extends Error {
  constructor(
    message: string,
    public start: number,
    public end: number,
  ) {
    super(message)
  }
}

/** Levenshtein distance, for "did you mean" on unknown field names. */
function editDistance(a: string, b: string): number {
  const dp: number[] = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]
    dp[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return dp[b.length]
}

/** Numbers coming out of arithmetic (17% → 0.17) can carry float dust; tidy to 10 dp. */
function tidy(n: number): number {
  return Math.round((n + Number.EPSILON) * 1e10) / 1e10
}

class Parser {
  private pos = 0

  constructor(
    private readonly text: string,
    private readonly tokens: RawToken[],
    private readonly fields: FormulaFieldRef[],
  ) {}

  private peek(offset = 0): RawToken {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]
  }

  private next(): RawToken {
    const t = this.tokens[this.pos]
    if (t.kind !== 'end') this.pos++
    return t
  }

  // Deliberately NOT a type predicate: a failed check must not narrow `t` away
  // from 'sym' (a later isSym on another symbol would then see `never`).
  private isSym(t: RawToken, ...syms: Sym[]): boolean {
    return t.kind === 'sym' && syms.includes(t.sym)
  }

  private describe(t: RawToken): string {
    if (t.kind === 'end') return 'the end of the formula'
    if (t.kind === 'sym') return `"${SYM_DISPLAY[t.sym]}"`
    return `"${this.text.slice(t.start, t.end)}"`
  }

  /** Does this token start an operand (a value)? Used to spot "12 area". */
  private startsOperand(t: RawToken): boolean {
    return t.kind === 'num' || (t.kind === 'ident' && !this.isKeywordToken(t)) || this.isSym(t, '(')
  }

  parse(): JsonLogic {
    const bad = this.tokens.find((t) => t.kind === 'bad')
    if (bad && bad.kind === 'bad') throw new ParseError(bad.message, bad.start, bad.end)

    const first = this.peek()
    if (first.kind === 'end') throw new ParseError('The formula is empty.', 0, 0)

    const node = this.parseOr()
    const rest = this.peek()
    if (rest.kind !== 'end') {
      if (this.isSym(rest, ')')) {
        throw new ParseError('Unexpected closing bracket ) — there is no matching (.', rest.start, rest.end)
      }
      if (this.isSym(rest, ',')) throw this.commaError(rest)
      if (this.startsOperand(rest)) {
        throw new ParseError(
          `Missing an operator before ${this.describe(rest)} — put +, −, × or ÷ between two values.`,
          rest.start,
          rest.end,
        )
      }
      throw new ParseError(`Unexpected ${this.describe(rest)}.`, rest.start, rest.end)
    }
    return node
  }

  private commaError(t: RawToken): ParseError {
    // "1,5" — a European decimal comma — is by far the most likely cause.
    const before = this.tokens[this.pos - 1]
    const after = this.peek(1)
    if (before?.kind === 'num' && after.kind === 'num' && after.start === t.end) {
      return new ParseError(
        `Use a dot for decimals: write "${this.text.slice(before.start, after.end).replace(',', '.')}", not "${this.text.slice(before.start, after.end)}".`,
        before.start,
        after.end,
      )
    }
    return new ParseError(
      'Unexpected comma — commas only separate the values inside a function, e.g. min(a, b).',
      t.start,
      t.end,
    )
  }

  private parseOr(): JsonLogic {
    const parts = [this.parseAnd()]
    while (this.peekKeyword('or')) {
      this.next()
      parts.push(this.parseAnd())
    }
    return parts.length === 1 ? parts[0] : { or: parts }
  }

  private parseAnd(): JsonLogic {
    const parts = [this.parseNot()]
    while (this.peekKeyword('and')) {
      this.next()
      parts.push(this.parseNot())
    }
    return parts.length === 1 ? parts[0] : { and: parts }
  }

  private parseNot(): JsonLogic {
    if (this.peekKeyword('not')) {
      this.next()
      return { '!': [this.parseNot()] }
    }
    return this.parseComparison()
  }

  private parseComparison(): JsonLogic {
    const left = this.parseSum()
    const t = this.peek()
    if (this.isSym(t, '<', '<=', '>', '>=', '==', '!=')) {
      this.next()
      this.requireOperand(t)
      const right = this.parseSum()
      const again = this.peek()
      if (this.isSym(again, '<', '<=', '>', '>=', '==', '!=')) {
        throw new ParseError(
          'Two comparisons in a row are not allowed — combine them with "and", e.g. a < b and b < c.',
          again.start,
          again.end,
        )
      }
      return { [(t as Extract<RawToken, { kind: 'sym' }>).sym]: [left, right] }
    }
    return left
  }

  private parseSum(): JsonLogic {
    let node = this.parseProduct()
    for (;;) {
      const t = this.peek()
      if (this.isSym(t, '+')) {
        this.next()
        this.requireOperand(t)
        const rhs = this.parseProduct()
        node = isOp(node, '+') ? { '+': [...(node['+'] as JsonLogic[]), rhs] } : { '+': [node, rhs] }
      } else if (this.isSym(t, '-')) {
        this.next()
        this.requireOperand(t)
        node = { '-': [node, this.parseProduct()] }
      } else {
        return node
      }
    }
  }

  private parseProduct(): JsonLogic {
    let node = this.parseUnary()
    for (;;) {
      const t = this.peek()
      if (this.isSym(t, '*')) {
        this.next()
        this.requireOperand(t)
        const rhs = this.parseUnary()
        node = isOp(node, '*') ? { '*': [...(node['*'] as JsonLogic[]), rhs] } : { '*': [node, rhs] }
      } else if (this.isSym(t, '/')) {
        this.next()
        this.requireOperand(t)
        node = { '/': [node, this.parseUnary()] }
      } else {
        return node
      }
    }
  }

  private parseUnary(): JsonLogic {
    const t = this.peek()
    if (this.isSym(t, '-')) {
      this.next()
      this.requireOperand(t)
      const operand = this.parseUnary()
      // A negated literal is just a negative number.
      if (typeof operand === 'number') return -operand
      return { '-': [operand] }
    }
    if (this.isSym(t, '+')) {
      this.next()
      this.requireOperand(t)
      return this.parseUnary()
    }
    return this.parsePostfix()
  }

  private parsePostfix(): JsonLogic {
    let node = this.parsePrimary()
    while (this.isSym(this.peek(), '%')) {
      this.next()
      node = typeof node === 'number' ? tidy(node / 100) : { '/': [node, 100] }
    }
    return node
  }

  private parsePrimary(): JsonLogic {
    const t = this.next()

    if (t.kind === 'num') return t.value

    if (t.kind === 'ident') {
      const lower = t.name.toLowerCase()
      if (!t.braced && FUNCTION_NAMES.has(lower)) return this.parseCall(lower as FunctionName, t)
      if (!t.braced && KEYWORDS.has(lower)) {
        throw new ParseError(`Something is missing before "${t.name}".`, t.start, t.end)
      }
      return this.fieldRef(t.name, t)
    }

    if (this.isSym(t, '(')) {
      const inner = this.parseOr()
      const close = this.peek()
      if (!this.isSym(close, ')')) {
        if (close.kind === 'end') {
          throw new ParseError('Missing a closing bracket ).', t.start, t.end)
        }
        if (this.isSym(close, ',')) throw this.commaError(close)
        if (this.startsOperand(close)) {
          throw new ParseError(
            `Missing an operator before ${this.describe(close)} — put +, −, × or ÷ between two values.`,
            close.start,
            close.end,
          )
        }
        throw new ParseError(`Unexpected ${this.describe(close)}.`, close.start, close.end)
      }
      this.next()
      return inner
    }

    if (t.kind === 'end') {
      const prev = this.tokens[this.pos - 1]
      throw new ParseError(
        prev ? `Something is missing after ${this.describe(prev)}.` : 'The formula is empty.',
        t.start,
        t.end,
      )
    }
    if (this.isSym(t, ')')) {
      const prev = this.tokens[this.pos - 2]
      if (prev && this.isSym(prev, '(')) {
        throw new ParseError('Empty brackets — put a calculation between ( and ).', prev.start, t.end)
      }
      throw new ParseError(`Something is missing before ")".`, t.start, t.end)
    }
    if (this.isSym(t, ',')) throw this.commaError(t)
    if (this.isSym(t, '*', '/', '%', '<', '<=', '>', '>=', '==', '!=')) {
      throw new ParseError(`Something is missing before ${this.describe(t)}.`, t.start, t.end)
    }
    throw new ParseError(`Unexpected ${this.describe(t)}.`, t.start, t.end)
  }

  /** After a binary/unary operator, the next token must begin a value. */
  private requireOperand(op: RawToken): void {
    const t = this.peek()
    if (this.startsOperand(t) || this.isSym(t, '-', '+')) return
    if (t.kind === 'end') {
      throw new ParseError(`Something is missing after ${this.describe(op)}.`, op.start, op.end)
    }
    throw new ParseError(
      `Expected a number or field after ${this.describe(op)}, not ${this.describe(t)}.`,
      t.start,
      t.end,
    )
  }

  private isKeywordToken(t: RawToken): boolean {
    return t.kind === 'ident' && !t.braced && KEYWORDS.has(t.name.toLowerCase())
  }

  private peekKeyword(word: 'and' | 'or' | 'not'): boolean {
    const t = this.peek()
    return t.kind === 'ident' && !t.braced && t.name.toLowerCase() === word
  }

  private fieldRef(name: string, t: RawToken): JsonLogic {
    if (this.fields.some((f) => f.fieldKey === name)) return { var: name }

    // Not a field: help with the most likely fix.
    const keys = this.fields.map((f) => f.fieldKey)
    const lower = name.toLowerCase()
    const byCase = keys.find((k) => k.toLowerCase() === lower)
    const byLabel = this.fields.find((f) => (f.label ?? '').trim().toLowerCase() === lower)
    // A half-typed key ("fin" for "finish") or an over-typed one ("finished").
    const byPrefix =
      lower.length >= 2
        ? keys.find((k) => k.toLowerCase().startsWith(lower) || lower.startsWith(k.toLowerCase()))
        : undefined
    const close = keys
      .map((k) => ({ k, d: editDistance(k.toLowerCase(), lower) }))
      .filter(({ k, d }) => d <= Math.max(2, Math.floor(k.length / 3)) && d < name.length)
      .sort((a, b) => a.d - b.d)[0]
    const suggestion = byCase ?? byLabel?.fieldKey ?? byPrefix ?? close?.k

    let message: string
    if (keys.length === 0) {
      message = `Unknown field "${name}" — this service has no calculator fields yet. Add fields above, then refer to them by their field key.`
    } else if (suggestion) {
      message = `Unknown field "${name}". Did you mean "${suggestion}"?`
    } else {
      const list = keys.slice(0, 6).join(', ') + (keys.length > 6 ? ', …' : '')
      message = `Unknown field "${name}". Fields you can use: ${list}.`
    }
    throw new ParseError(message, t.start, t.end)
  }

  private parseCall(fn: FunctionName, nameTok: RawToken): JsonLogic {
    const open = this.peek()
    const info = FORMULA_FUNCTIONS.find((f) => f.name === fn)!
    if (!this.isSym(open, '(')) {
      throw new ParseError(
        `"${fn}" needs brackets: ${info.signature}.`,
        nameTok.start,
        nameTok.end,
      )
    }
    this.next()

    const args: JsonLogic[] = []
    if (this.isSym(this.peek(), ')')) {
      this.next()
      throw new ParseError(`"${fn}" needs values inside the brackets: ${info.signature}.`, nameTok.start, this.tokens[this.pos - 1].end)
    }
    for (;;) {
      args.push(this.parseOr())
      const t = this.peek()
      if (this.isSym(t, ',')) {
        this.next()
        continue
      }
      if (this.isSym(t, ')')) {
        this.next()
        break
      }
      if (t.kind === 'end') {
        throw new ParseError(`Missing the closing bracket ) of "${fn}(…)".`, nameTok.start, open.end)
      }
      if (this.startsOperand(t)) {
        throw new ParseError(
          `Missing an operator or comma before ${this.describe(t)} inside "${fn}(…)".`,
          t.start,
          t.end,
        )
      }
      throw new ParseError(`Unexpected ${this.describe(t)} inside "${fn}(…)".`, t.start, t.end)
    }

    const span = { start: nameTok.start, end: this.tokens[this.pos - 1].end }
    const arity = (ok: boolean, expected: string) => {
      if (!ok) {
        throw new ParseError(
          `"${fn}" expects ${expected}, but got ${args.length} value${args.length === 1 ? '' : 's'}: ${info.signature}.`,
          span.start,
          span.end,
        )
      }
    }

    switch (fn) {
      case 'if':
        arity(args.length >= 3 && args.length % 2 === 1, 'a condition, a value when true and a value when false (more condition/value pairs may be added in between)')
        return { if: args }
      case 'min':
      case 'max':
        arity(args.length >= 2, 'at least two values')
        return { [fn]: args }
      case 'round':
        arity(args.length === 1 || args.length === 2, 'one value, optionally followed by the number of decimals')
        return { round: args }
      case 'ceil':
      case 'floor':
      case 'abs':
        arity(args.length === 1, 'exactly one value')
        return { [fn]: args }
      case 'mod':
        arity(args.length === 2, 'exactly two values')
        return { '%': args }
    }
  }
}

function isOp(node: JsonLogic, op: string): node is Record<string, JsonLogic> {
  return typeof node === 'object' && node !== null && !Array.isArray(node) && Object.keys(node).length === 1 && op in node
}

export interface CompileResult {
  /** The JSONLogic rule, or null when the text is blank or has an error. */
  logic: JsonLogic | null
  error: ExpressionError | null
  /** True when the text is blank/whitespace (⇒ "no formula", not an error). */
  empty: boolean
}

/** Parse an expression into JSONLogic, or explain (in plain words) why it can't be. */
export function compileExpression(text: string, fields: FormulaFieldRef[]): CompileResult {
  if (text.trim() === '') return { logic: null, error: null, empty: true }
  try {
    const logic = new Parser(text, tokenize(text), fields).parse()
    return { logic, error: null, empty: false }
  } catch (e) {
    if (e instanceof ParseError) {
      return { logic: null, error: { message: e.message, start: e.start, end: e.end }, empty: false }
    }
    throw e
  }
}

// ---------------------------------------------------------------------------
// Printer: JSONLogic → expression text
// ---------------------------------------------------------------------------

const PREC = {
  or: 1,
  and: 2,
  not: 3,
  cmp: 4,
  add: 5,
  mul: 6,
  unary: 7,
  atom: 9,
} as const

interface Printed {
  text: string
  prec: number
}

function formatNumber(n: number): string | null {
  if (!Number.isFinite(n)) return null
  if (n === 0) return '0'
  const s = String(n)
  if (!s.includes('e')) return s
  // Avoid exponent notation (1e-7, 1e+21) — the parser doesn't read it.
  return n.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 12 })
}

/** How a field key is written in the language: bare when it can be, else braced. */
export function fieldKeyToText(key: string): string {
  return IDENT_RE.test(key) && !isReservedWord(key) ? key : `{${key}}`
}

const CMP_TEXT: Record<string, string> = { '==': '=', '!=': '≠', '<': '<', '<=': '≤', '>': '>', '>=': '≥' }

export interface PrintOptions {
  /** How to render a field reference — defaults to its key (bare or braced). */
  nameFor?: (key: string) => string
}

/**
 * Render a JSONLogic rule as an expression, with the minimum brackets the
 * precedence rules require. Returns null when the rule uses something the
 * language can't express (a hand-authored raw rule) — the editor then offers
 * the raw-JSON view instead.
 */
export function printFormula(rule: unknown, opts: PrintOptions = {}): string | null {
  const nameFor = opts.nameFor ?? fieldKeyToText

  const wrapIf = (p: Printed, cond: boolean): string => (cond ? `(${p.text})` : p.text)

  const print = (node: unknown): Printed | null => {
    if (typeof node === 'number') {
      const s = formatNumber(node)
      if (s === null) return null
      return { text: s, prec: node < 0 ? PREC.unary : PREC.atom }
    }
    if (typeof node === 'boolean') return { text: node ? '1' : '0', prec: PREC.atom }
    if (node === null || node === undefined) return { text: '0', prec: PREC.atom }
    if (typeof node !== 'object' || Array.isArray(node)) return null

    const keys = Object.keys(node)
    if (keys.length !== 1) return null
    const op = keys[0]
    const raw = (node as Record<string, unknown>)[op]
    const args: unknown[] = Array.isArray(raw) ? raw : [raw]

    if (op === 'var') {
      const key = args[0]
      if (typeof key !== 'string') return null
      // A non-zero default has no spelling in the language.
      if (args.length > 1 && args[1] !== 0 && args[1] !== null) return null
      return { text: nameFor(key), prec: PREC.atom }
    }

    const parts = args.map(print)
    if (parts.some((p) => p === null)) return null
    const ps = parts as Printed[]

    // A right-hand operand that starts with a minus sign gets brackets even
    // when precedence wouldn't demand them: "a − (−5)" beats "a − −5".
    const rhs = (p: Printed, minPrec: number) => wrapIf(p, p.prec <= minPrec || p.text.startsWith('-'))
    const lhs = (p: Printed, minPrec: number) => wrapIf(p, p.prec < minPrec)

    switch (op) {
      case '+':
        if (ps.length === 0) return null
        if (ps.length === 1) return ps[0]
        return {
          text: ps.map((p, i) => (i === 0 ? lhs(p, PREC.add) : wrapIf(p, p.prec < PREC.add || p.text.startsWith('-')))).join(' + '),
          prec: PREC.add,
        }
      case '*':
        if (ps.length === 0) return null
        if (ps.length === 1) return ps[0]
        return {
          text: ps.map((p, i) => (i === 0 ? lhs(p, PREC.mul) : wrapIf(p, p.prec < PREC.mul || p.text.startsWith('-')))).join(' × '),
          prec: PREC.mul,
        }
      case '-': {
        if (ps.length === 0) return null
        if (ps.length === 1) {
          return { text: `-${wrapIf(ps[0], ps[0].prec < PREC.unary || ps[0].text.startsWith('-'))}`, prec: PREC.unary }
        }
        let text = lhs(ps[0], PREC.add)
        for (let i = 1; i < ps.length; i++) text += ` − ${rhs(ps[i], PREC.add)}`
        return { text, prec: PREC.add }
      }
      case '/':
        if (ps.length !== 2) return null
        return { text: `${lhs(ps[0], PREC.mul)} ÷ ${rhs(ps[1], PREC.mul)}`, prec: PREC.mul }
      case '%':
        if (ps.length !== 2) return null
        return { text: `mod(${ps[0].text}, ${ps[1].text})`, prec: PREC.atom }
      case '==':
      case '!=':
      case '<':
      case '<=':
      case '>':
      case '>=':
        if (ps.length !== 2) return null
        return {
          text: `${wrapIf(ps[0], ps[0].prec <= PREC.cmp)} ${CMP_TEXT[op]} ${wrapIf(ps[1], ps[1].prec <= PREC.cmp)}`,
          prec: PREC.cmp,
        }
      case '!':
        if (ps.length !== 1) return null
        return { text: `not ${wrapIf(ps[0], ps[0].prec < PREC.not)}`, prec: PREC.not }
      case 'and':
        if (ps.length === 0) return null
        if (ps.length === 1) return ps[0]
        return { text: ps.map((p) => wrapIf(p, p.prec < PREC.and)).join(' and '), prec: PREC.and }
      case 'or':
        if (ps.length === 0) return null
        if (ps.length === 1) return ps[0]
        return { text: ps.map((p) => wrapIf(p, p.prec < PREC.or)).join(' or '), prec: PREC.or }
      case 'if':
        if (ps.length < 3 || ps.length % 2 === 0) return null
        return { text: `if(${ps.map((p) => p.text).join(', ')})`, prec: PREC.atom }
      case 'min':
      case 'max':
        if (ps.length < 2) return null
        return { text: `${op}(${ps.map((p) => p.text).join(', ')})`, prec: PREC.atom }
      case 'round':
        if (ps.length < 1 || ps.length > 2) return null
        return { text: `round(${ps.map((p) => p.text).join(', ')})`, prec: PREC.atom }
      case 'ceil':
      case 'floor':
      case 'abs':
        if (ps.length !== 1) return null
        return { text: `${op}(${ps[0].text})`, prec: PREC.atom }
      default:
        return null
    }
  }

  const out = print(rule)
  return out ? out.text : null
}

/**
 * The formula "in words": the same rendering with each field's visible label in
 * place of its key — what the editor shows under the formula bar so the admin
 * can confirm `rate` really is "Price per m²".
 */
export function describeFormula(rule: unknown, fields: FormulaFieldRef[]): string | null {
  const labels = new Map(fields.map((f) => [f.fieldKey, (f.label ?? '').trim() || f.fieldKey]))
  return printFormula(rule, { nameFor: (key) => labels.get(key) ?? key })
}

// ---------------------------------------------------------------------------
// Stored value: JSONLogic | draft marker | null
// ---------------------------------------------------------------------------

export const FORMULA_DRAFT_KEY = '__draft'

export interface FormulaDraft {
  [FORMULA_DRAFT_KEY]: string
}

export function isFormulaDraft(value: unknown): value is FormulaDraft {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof (value as Record<string, unknown>)[FORMULA_DRAFT_KEY] === 'string'
  )
}

/** True when a stored `formula` value means "no formula" (⇒ default per-field sum). */
export function isEmptyFormulaValue(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (Array.isArray(value)) return value.length === 0
  return typeof value === 'object' && Object.keys(value as object).length === 0
}

/**
 * What the editor stores for a given text: JSONLogic when it compiles, null
 * when blank, and the draft marker (so the text survives) when it doesn't.
 */
export function toStoredFormula(
  text: string,
  fields: FormulaFieldRef[],
): { value: JsonLogic | FormulaDraft | null; error: ExpressionError | null } {
  const { logic, error, empty } = compileExpression(text, fields)
  if (empty) return { value: null, error: null }
  if (error) return { value: { [FORMULA_DRAFT_KEY]: text }, error }
  return { value: logic, error: null }
}

/**
 * The text to show for a stored value: the saved draft text, the printed
 * expression, or null when the value is JSONLogic the language can't express
 * (⇒ the editor shows it as raw JSON).
 */
export function readStoredFormula(value: unknown): string | null {
  if (isEmptyFormulaValue(value)) return ''
  if (isFormulaDraft(value)) return value[FORMULA_DRAFT_KEY]
  return printFormula(value)
}

// ---------------------------------------------------------------------------
// Validation of the STORED value (Payload field `validate`, server + client)
// ---------------------------------------------------------------------------

/**
 * Walk a JSONLogic rule and confirm the evaluator can run it: only supported
 * operators, sane arities, numeric literals, and `var`s that name one of the
 * service's calculator fields. Returns a plain-language problem, or null.
 */
export function findLogicProblem(rule: unknown, fieldKeys: readonly string[]): string | null {
  const known = new Set(fieldKeys)

  const walk = (node: unknown): string | null => {
    if (typeof node === 'number') return Number.isFinite(node) ? null : 'contains a number that is not finite.'
    if (typeof node === 'boolean' || node === null) return null
    if (typeof node === 'string') return `contains the text value "${node}" — only numbers and fields are allowed.`
    if (typeof node !== 'object') return 'contains an unsupported value.'
    if (Array.isArray(node)) return 'contains a bare list where a calculation was expected.'

    const keys = Object.keys(node)
    if (keys.length !== 1) return 'contains a step with more than one operator.'
    const op = keys[0]
    const raw = (node as Record<string, unknown>)[op]
    const args: unknown[] = Array.isArray(raw) ? raw : [raw]

    if (op === FORMULA_DRAFT_KEY) return 'is an unfinished draft.'
    if (op === 'var') {
      const key = args[0]
      if (typeof key !== 'string') return 'references a field without a name.'
      if (!known.has(key)) {
        return `uses "${key}", which is not one of this service's calculator fields${known.size ? ` (available: ${[...known].join(', ')})` : ''}.`
      }
      return null
    }
    if (!isSupportedOperator(op)) return `uses the unsupported operation "${op}".`

    const arity: Record<string, [number, number]> = {
      '+': [1, Infinity],
      '*': [1, Infinity],
      '-': [1, Infinity],
      '/': [2, 2],
      '%': [2, 2],
      min: [1, Infinity],
      max: [1, Infinity],
      '==': [2, 2],
      '!=': [2, 2],
      '<': [2, 3],
      '<=': [2, 3],
      '>': [2, 3],
      '>=': [2, 3],
      and: [1, Infinity],
      or: [1, Infinity],
      '!': [1, 1],
      '!!': [1, 1],
      if: [2, Infinity],
      round: [1, 2],
      ceil: [1, 1],
      floor: [1, 1],
      abs: [1, 1],
    }
    const [min, max] = arity[op]
    if (args.length < min || args.length > max) {
      return `gives "${op}" ${args.length} value${args.length === 1 ? '' : 's'} where ${max === Infinity ? `at least ${min}` : min === max ? `exactly ${min}` : `${min} to ${max}`} ${min === 1 && max === 1 ? 'is' : 'are'} expected.`
    }
    for (const a of args) {
      const problem = walk(a)
      if (problem) return problem
    }
    return null
  }

  return walk(rule)
}

/**
 * Payload `validate` for `Services.formula`: `true`, or the message shown on the
 * field. An empty value is fine (default per-field summation). A draft marker
 * is re-checked against the current fields so the message names the real cause.
 */
export function validateStoredFormula(value: unknown, fields: FormulaFieldRef[]): string | true {
  if (isEmptyFormulaValue(value)) return true

  if (isFormulaDraft(value)) {
    const { error } = compileExpression(value[FORMULA_DRAFT_KEY], fields)
    return error
      ? `The price formula has an error: ${error.message}`
      : 'The price formula was left as an unfinished draft — open the Price Formula section and re-save it.'
  }

  const problem = findLogicProblem(value, fields.map((f) => f.fieldKey))
  return problem ? `The price formula ${problem}` : true
}
