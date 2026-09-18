'use client'

/**
 * Formula Builder — custom admin field for the Services `formula` field
 * (TECHSPEC §6.4, FUNCTIONALITY §5.3; rebuilt 2026-09-14 as a formula bar).
 *
 * The admin writes the price as an ordinary expression — `area × rate + 200`,
 * `if(area > 100, area × 10, area × 12)`, `ceil(area / 1.7) × 250` — in a
 * single formula bar with syntax highlighting, bracket matching, autocomplete
 * for field keys/functions, and click-to-insert chips for every field, operator
 * and function, so nothing has to be typed from memory. Under the bar, the
 * formula is read back "in words" (field labels instead of keys) or a
 * plain-language error points at the exact spot. A **Test / Preview** tab feeds
 * sample inputs through the very same `computePrice()` the public page uses.
 *
 * Everything language-related (tokenizer, parser → JSONLogic, printer,
 * validation) lives in the pure `src/lib/pricing/formulaExpression.ts`; this
 * file is only the UI over it. The stored value stays plain JSONLogic (with a
 * `{ "__draft": text }` marker while the text does not parse, which the field's
 * server-side `validate` rejects — see that module), so the public calculator,
 * the evaluator and the PDF are untouched and no migration is needed. A formula
 * that JSONLogic can express but the language can't (hand-authored raw JSON) is
 * shown in a raw-JSON editor instead — nothing is ever locked out.
 */

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react'
import { useAllFormFields, useField } from '@payloadcms/ui'
import { reduceFieldsToValues } from 'payload/shared'

import {
  FORMULA_FUNCTIONS,
  compileExpression,
  describeFormula,
  fieldKeyToText,
  highlightTokens,
  isReservedWord,
  readStoredFormula,
  toStoredFormula,
  validateStoredFormula,
  type ExpressionError,
  type FormulaFieldRef,
  type HighlightToken,
} from '@/lib/pricing/formulaExpression'
import {
  coerceInputs,
  computePrice,
  formatCurrency,
  toPricingFields,
  type PricingField,
  type RawInput,
} from '@/lib/pricing'
import type { JsonLogic } from '@/lib/pricing/jsonlogic'

import './FormulaBuilder.scss'

type Props = { path?: string }

const PREVIEW_LOCALE = 'en'

// ---------------------------------------------------------------------------
// Palette content
// ---------------------------------------------------------------------------

const OPERATOR_CHIPS: { text: string; title: string }[] = [
  { text: '+', title: 'Add' },
  { text: '−', title: 'Subtract' },
  { text: '×', title: 'Multiply' },
  { text: '÷', title: 'Divide' },
  { text: '(', title: 'Open bracket — groups a calculation so it happens first' },
  { text: ')', title: 'Close bracket' },
  { text: '%', title: 'Percent — 17% means 0.17, so × (1 + 17%) adds 17 % VAT' },
]

const COMPARE_CHIPS: { text: string; title: string }[] = [
  { text: '>', title: 'Greater than' },
  { text: '<', title: 'Less than' },
  { text: '≥', title: 'Greater than or equal' },
  { text: '≤', title: 'Less than or equal' },
  { text: '=', title: 'Equal to' },
  { text: '≠', title: 'Not equal to' },
  { text: 'and', title: 'Both conditions must hold' },
  { text: 'or', title: 'Either condition may hold' },
  { text: 'not', title: 'The opposite of a condition' },
]

/** Worked examples for the reference panel — plain pricing situations. */
const RECIPES: { need: string; formula: string }[] = [
  { need: 'Multiply two fields', formula: 'area × rate' },
  { need: 'Add a fixed cost', formula: 'area × rate + 200' },
  { need: 'Add 17 % VAT to everything', formula: '(area × rate + 200) × (1 + 17%)' },
  { need: 'Cheaper rate above 100 m²', formula: 'if(area > 100, area × 10, area × 12)' },
  { need: 'Never below a minimum charge', formula: 'max(area × 12, 500)' },
  { need: 'Never above a cap', formula: 'min(area × 12, 5000)' },
  { need: 'Whole units (e.g. panels of 1.7 m²)', formula: 'ceil(area / 1.7) × 250' },
  { need: 'A yes/no option adds a fee', formula: 'area × 12 + rush × 200' },
  { need: 'Combine conditions', formula: 'if(rush = 1 and area > 50, 150, 0)' },
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The formula the default (no-formula) pricing implies — Σ signed unitPrice × field
 * — written in the language, so the admin can start from what already happens
 * and adjust it rather than from a blank line.
 */
function defaultSumExpression(fields: PricingField[]): string {
  const parts: { text: string; negative: boolean }[] = []
  for (const f of fields) {
    if (f.unitPrice === null || f.unitPrice === undefined) continue
    const key = fieldKeyToText(f.fieldKey)
    const price = Math.abs(f.unitPrice)
    const text = price === 1 ? key : `${key} × ${price}`
    parts.push({ text, negative: (f.sign === 'subtract') !== (f.unitPrice < 0) })
  }
  return parts
    .map((p, i) => (i === 0 ? (p.negative ? `-${p.text}` : p.text) : `${p.negative ? '−' : '+'} ${p.text}`))
    .join(' ')
}

/** Find the bracket that pairs with the one at token index `i`, if any. */
function matchingParen(tokens: HighlightToken[], i: number): number {
  const t = tokens[i]
  if (t.kind !== 'paren') return -1
  if (t.text === '(') {
    for (let j = i + 1; j < tokens.length; j++) {
      const u = tokens[j]
      if (u.kind === 'paren' && u.text === ')' && u.depth === t.depth) return j
    }
  } else {
    for (let j = i - 1; j >= 0; j--) {
      const u = tokens[j]
      if (u.kind === 'paren' && u.text === '(' && u.depth === t.depth) return j
    }
  }
  return -1
}

type Suggestion =
  | { kind: 'field'; key: string; label: string; insert: string }
  | { kind: 'function'; name: string; signature: string; insert: string }
  | { kind: 'keyword'; name: string; insert: string }

/** Autocomplete candidates for the word being typed before the caret. */
function suggestionsFor(
  text: string,
  caret: number,
  fields: FormulaFieldRef[],
): { items: Suggestion[]; start: number } | null {
  const before = text.slice(0, caret)
  const m = /(\{[^}]*|[\p{L}_][\p{L}\p{N}_]*)$/u.exec(before)
  if (!m) return null
  const raw = m[1]
  const braced = raw.startsWith('{')
  const query = (braced ? raw.slice(1) : raw).trim().toLowerCase()
  if (query === '' && !braced) return null

  const items: Suggestion[] = []
  for (const f of fields) {
    const label = (f.label ?? '').trim()
    if (f.fieldKey.toLowerCase().includes(query) || label.toLowerCase().includes(query)) {
      items.push({ kind: 'field', key: f.fieldKey, label: label || f.fieldKey, insert: fieldKeyToText(f.fieldKey) })
    }
  }
  if (!braced) {
    for (const fn of FORMULA_FUNCTIONS) {
      if (fn.name.startsWith(query)) {
        items.push({ kind: 'function', name: fn.name, signature: fn.signature, insert: fn.insert })
      }
    }
    for (const kw of ['and', 'or', 'not']) {
      if (kw.startsWith(query) && kw !== query) items.push({ kind: 'keyword', name: kw, insert: `${kw} ` })
    }
  }
  // Nothing to offer once the word already IS the only match.
  if (items.length === 0) return null
  if (items.length === 1 && items[0].kind === 'field' && items[0].key === (braced ? raw.slice(1).trim() : raw)) {
    return null
  }
  return { items: items.slice(0, 8), start: caret - raw.length }
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/** Show an error only once typing has paused — no red flashes mid-keystroke. */
function useSettledError(error: ExpressionError | null, delayMs: number): ExpressionError | null {
  // Keyed on the error's CONTENT, not the object: every form-state update
  // re-runs the parser and yields a fresh object for the same problem, which
  // must neither restart the timer nor make an already-shown error blink.
  const key = error ? [error.start, error.end, error.message].join('|') : ''
  const [settledKey, setSettledKey] = useState('')
  useEffect(() => {
    if (!key) return
    const timer = setTimeout(() => setSettledKey(key), delayMs)
    return () => clearTimeout(timer)
  }, [key, delayMs])
  return error && settledKey === key ? error : null
}

export const FormulaBuilder = ({ path = 'formula' }: Props) => {
  const [allFields] = useAllFormFields()
  const uid = useId()

  // Live list of the service's calculator fields (from sibling form state).
  const pricingFields: PricingField[] = useMemo(() => {
    const data = reduceFieldsToValues(allFields, true) as { calculatorFields?: unknown }
    return toPricingFields((data.calculatorFields as Parameters<typeof toPricingFields>[0]) ?? [])
  }, [allFields])
  // Memoised on CONTENT (keys + labels), not on the array identity: Payload
  // rebuilds form state on every change and every server round trip, and a
  // fresh array each time would cascade into re-parses, re-registered
  // validators and reset timers below.
  const refSignature = pricingFields.map((f) => f.fieldKey + '|' + f.label).join('||')
  const fieldRefs: FormulaFieldRef[] = useMemo(
    () => pricingFields.map((f) => ({ fieldKey: f.fieldKey, label: f.label })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refSignature captures pricingFields' relevant content
    [refSignature],
  )
  const keySignature = fieldRefs.map((f) => f.fieldKey).join('|')

  // The same check the server runs (the Services.formula validate), registered
  // client-side too so Save/Publish is refused immediately, with the message on
  // the field, instead of after a round trip.
  const clientValidate = useCallback(
    (val: unknown) => validateStoredFormula(val, fieldRefs),
    [fieldRefs],
  )
  const { value, setValue, showError, errorMessage } = useField<JsonLogic | null>({
    path,
    validate: clientValidate,
  })

  // --- editor state ----------------------------------------------------------
  const [text, setText] = useState<string>(() => readStoredFormula(value) ?? '')
  const [mode, setMode] = useState<'expression' | 'raw'>(() =>
    readStoredFormula(value) === null ? 'raw' : 'expression',
  )
  const [rawText, setRawText] = useState<string>(() => (value ? JSON.stringify(value, null, 2) : ''))
  const [rawError, setRawError] = useState<string | null>(null)
  const [tab, setTab] = useState<'compose' | 'test'>('compose')
  const [sample, setSample] = useState<Record<string, RawInput>>({})

  const compiled = useMemo(() => compileExpression(text, fieldRefs), [text, fieldRefs])
  const readsAs = useMemo(
    () => (compiled.logic ? describeFormula(compiled.logic, fieldRefs) : null),
    [compiled.logic, fieldRefs],
  )

  // Commit new text: local state + the stored value (JSONLogic / draft / null).
  const applyText = useCallback(
    (next: string) => {
      setText(next)
      setValue(toStoredFormula(next, fieldRefs).value)
    },
    [fieldRefs, setValue],
  )

  // When the calculator fields change AFTER mount (a key renamed, a field added),
  // the same text may now compile — or stop compiling. Re-derive the stored value
  // so it always mirrors the text. Not on mount: that would mark an untouched
  // form as modified. Only when the result actually differs.
  const prevSignature = useRef(keySignature)
  useEffect(() => {
    if (prevSignature.current === keySignature) return
    prevSignature.current = keySignature
    if (mode !== 'expression') return
    const next = toStoredFormula(text, fieldRefs).value
    if (JSON.stringify(next ?? null) !== JSON.stringify(value ?? null)) setValue(next)
  }, [keySignature, mode, text, fieldRefs, value, setValue])

  // --- caret-aware insertion (palette chips, autocomplete) -------------------
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const pendingCaret = useRef<number | null>(null)

  useLayoutEffect(() => {
    const ta = textareaRef.current
    if (!ta || pendingCaret.current === null) return
    ta.setSelectionRange(pendingCaret.current, pendingCaret.current)
    pendingCaret.current = null
  }, [text])

  /** Insert at the caret (replacing any selection), spacing it like typed text. `|` marks where the caret lands. */
  const insertSnippet = useCallback(
    (snippet: string, range?: [number, number]) => {
      const ta = textareaRef.current
      const start = range?.[0] ?? ta?.selectionStart ?? text.length
      const end = range?.[1] ?? ta?.selectionEnd ?? text.length
      // `|` is a caret marker in our own chip snippets (never formula syntax —
      // the language has no `|` operator), so every occurrence is stripped and
      // the FIRST one decides where the caret lands.
      const caretMark = snippet.indexOf('|')
      const clean = snippet.replaceAll('|', '')
      const before = text.slice(0, start)
      const after = text.slice(end)
      const spaceBefore = before.length > 0 && !/[\s(]$/.test(before) && !/^[)%,]/.test(clean)
      const spaceAfter = after.length > 0 && !/^[\s),%]/.test(after) && !/[(]$/.test(clean)
      const inserted = `${spaceBefore ? ' ' : ''}${clean}${spaceAfter ? ' ' : ''}`
      pendingCaret.current = start + (spaceBefore ? 1 : 0) + (caretMark >= 0 ? caretMark : clean.length)
      applyText(before + inserted + after)
      ta?.focus()
    },
    [applyText, text],
  )

  // --- raw-mode handlers ------------------------------------------------------
  const applyRaw = (next: string) => {
    setRawText(next)
    if (next.trim() === '') {
      setRawError(null)
      setValue(null)
      return
    }
    try {
      const parsed = JSON.parse(next) as JsonLogic
      setRawError(null)
      setValue(parsed)
    } catch {
      setRawError('Not valid JSON — the last valid value is still saved.')
    }
  }

  const switchToExpression = () => {
    const printed = readStoredFormula(value)
    if (printed === null) {
      const ok = window.confirm(
        'This formula uses operations the formula bar cannot show. Switch anyway and start from an empty formula? (The current raw formula is replaced when you edit.)',
      )
      if (!ok) return
      setText('')
      setValue(null)
    } else {
      setText(printed)
    }
    setMode('expression')
  }

  const switchToRaw = () => {
    setRawText(value ? JSON.stringify(value, null, 2) : '')
    setRawError(null)
    setMode('raw')
  }

  const clearAll = () => {
    applyText('')
    setRawText('')
    setRawError(null)
    textareaRef.current?.focus()
  }

  const defaultSum = useMemo(() => defaultSumExpression(pricingFields), [pricingFields])

  // --- live preview -------------------------------------------------------------
  const preview = useMemo(() => {
    const inputs = coerceInputs(pricingFields, sample)
    return computePrice({ fields: pricingFields, formula: value ?? null, inputs })
  }, [pricingFields, sample, value])

  // Mirror the public calculator's required-field gating EXACTLY so the preview
  // matches production: the total is withheld until every required number field
  // has a value. An explicit 0 counts as filled; only an untouched/blank field
  // is "missing". See ServiceCalculator.tsx.
  const missingRequired = useMemo(
    () =>
      pricingFields.filter(
        (f) =>
          f.required &&
          f.type === 'number' &&
          (sample[f.fieldKey] === '' || sample[f.fieldKey] === null || sample[f.fieldKey] === undefined),
      ),
    [pricingFields, sample],
  )
  const hasAllRequired = missingRequired.length === 0
  const setSampleValue = (key: string, v: RawInput) => setSample((prev) => ({ ...prev, [key]: v }))

  // --- errors -----------------------------------------------------------------------
  // The live parse result drives the stored value at once, but its message and
  // underline appear only after a short pause — while you are still typing
  // "area ×", "something is missing after ×" is noise, not help.
  const liveError: ExpressionError | null = mode === 'expression' ? compiled.error : null
  const ownError = useSettledError(liveError, 450)
  // A server-side validation message (after a failed save) that the client
  // parse did not produce itself — e.g. the raw JSON references a missing field.
  const serverError = showError && errorMessage && !ownError ? errorMessage : null
  const hasError = !!ownError || !!serverError

  // -------------------------------------------------------------------------------
  const TABS = [
    { id: 'compose', label: 'Formula' },
    { id: 'test', label: 'Test / Preview' },
  ] as const

  // WAI-ARIA tab pattern: arrow keys move between tabs, Home/End jump to the
  // ends, and only the selected tab stays in the tab order.
  const onTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const order = TABS.map((t) => t.id)
    const i = order.indexOf(tab)
    let next: (typeof order)[number] | null = null
    if (e.key === 'ArrowRight') next = order[(i + 1) % order.length]
    else if (e.key === 'ArrowLeft') next = order[(i - 1 + order.length) % order.length]
    else if (e.key === 'Home') next = order[0]
    else if (e.key === 'End') next = order[order.length - 1]
    if (!next) return
    e.preventDefault()
    setTab(next)
    document.getElementById(`fb-tab-${next}`)?.focus()
  }

  const statusId = `${uid}-status`

  return (
    <div className={`fb field-type${hasError ? ' error' : ''}`}>
      <div className="fb-head">
        {/* The section header above already reads "Price Formula Builder", so the
            field's own label is for assistive tech only. */}
        <label className="field-label visually-hidden" htmlFor={`${uid}-input`}>
          Price formula
        </label>
        <p className="fb-help">
          Write the price as a calculation over the fields above — any formula you
          like, with brackets, conditions and rounding. Leave it empty to simply add
          up each field&rsquo;s own unit price.
        </p>
        <div className="fb-modes">
          {mode === 'expression' ? (
            <button type="button" className="fb-link" onClick={switchToRaw}>
              Edit raw JSON
            </button>
          ) : (
            <button type="button" className="fb-link" onClick={switchToExpression}>
              Use the formula bar
            </button>
          )}
        </div>
      </div>

      <div className="fb-card">
        <div className="fb-tabs" role="tablist" aria-label="Price formula">
          {TABS.map((t) => (
            <button
              aria-controls={`fb-panel-${t.id}`}
              aria-selected={tab === t.id}
              className={`fb-tab${tab === t.id ? ' is-active' : ''}`}
              id={`fb-tab-${t.id}`}
              key={t.id}
              onClick={() => setTab(t.id)}
              onKeyDown={onTabKeyDown}
              role="tab"
              tabIndex={tab === t.id ? 0 : -1}
              type="button"
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* --- Tab 1: the formula ------------------------------------------ */}
        <div
          aria-labelledby="fb-tab-compose"
          className="fb-panel"
          hidden={tab !== 'compose'}
          id="fb-panel-compose"
          role="tabpanel"
          tabIndex={0}
        >
          {mode === 'raw' ? (
            <div className="fb-raw">
              <textarea
                className="fb-raw-input"
                value={rawText}
                spellCheck={false}
                rows={10}
                onChange={(e) => applyRaw(e.target.value)}
                placeholder='e.g. {"+":[{"*":[{"var":"area"},12]},100]}'
                aria-describedby={serverError ? statusId : undefined}
              />
              {rawError && <p className="fb-error">{rawError}</p>}
              {serverError && (
                <p className="fb-error" id={statusId} role="status">
                  {serverError}
                </p>
              )}
              <p className="fb-help">
                Advanced: a JSONLogic rule. Supported operations: <code>var</code>,{' '}
                <code>+ &minus; &times; &divide; %</code>, <code>min</code>, <code>max</code>,{' '}
                <code>if</code>, comparisons, <code>and</code>/<code>or</code>/<code>!</code>,{' '}
                <code>round</code>, <code>ceil</code>, <code>floor</code>, <code>abs</code>.
                Anything else cannot be saved.
              </p>
            </div>
          ) : (
            <>
              <FormulaInput
                id={`${uid}-input`}
                describedBy={statusId}
                error={ownError}
                fields={fieldRefs}
                onChange={applyText}
                onInsert={insertSnippet}
                textareaRef={textareaRef}
                value={text}
              />

              <div
                className={`fb-status${hasError ? ' fb-status--error' : compiled.empty ? ' fb-status--empty' : liveError ? ' fb-status--pending' : ' fb-status--ok'}`}
                id={statusId}
                role={hasError ? 'status' : undefined}
              >
                {ownError ? (
                  <>
                    <span className="fb-status__label">Problem</span>
                    <span className="fb-status__text">{ownError.message}</span>
                  </>
                ) : serverError ? (
                  <>
                    <span className="fb-status__label">Problem</span>
                    <span className="fb-status__text">{serverError}</span>
                  </>
                ) : compiled.empty ? (
                  <span className="fb-status__text">
                    No formula &mdash; the price is the sum of each field&rsquo;s unit price
                    &times; its value. Type a formula, click the chips below, or start from
                    the default sum.
                  </span>
                ) : liveError ? (
                  // Not valid yet — the message itself is held back until typing pauses.
                  <span className="fb-status__text fb-status__pending">&hellip;</span>
                ) : (
                  <>
                    <span className="fb-status__label">Reads as</span>
                    <span className="fb-status__text fb-status__reads">{readsAs}</span>
                  </>
                )}
              </div>

              <div className="fb-quick">
                {defaultSum && (
                  <button
                    type="button"
                    className="fb-quick__btn"
                    onClick={() => {
                      pendingCaret.current = defaultSum.length
                      applyText(defaultSum)
                      textareaRef.current?.focus()
                    }}
                    title={defaultSum}
                  >
                    {compiled.empty ? 'Start from the default sum' : 'Replace with the default sum'}
                  </button>
                )}
                {!compiled.empty && (
                  <button type="button" className="fb-quick__btn fb-quick__btn--danger" onClick={clearAll}>
                    Clear formula
                  </button>
                )}
              </div>

              <div className="fb-palette" aria-label="Insert into the formula">
                <div className="fb-palette__group">
                  <span className="fb-palette__label">Fields</span>
                  <div className="fb-palette__chips">
                    {fieldRefs.length === 0 && (
                      <span className="fb-palette__empty">
                        No calculator fields yet &mdash; add fields above, then use them here.
                      </span>
                    )}
                    {fieldRefs.map((f) => (
                      <button
                        type="button"
                        className="fb-chip fb-chip--field"
                        key={f.fieldKey}
                        onClick={() => insertSnippet(fieldKeyToText(f.fieldKey))}
                        title={`Insert "${f.fieldKey}" — ${(f.label ?? '').trim() || f.fieldKey}`}
                      >
                        <span className="fb-chip__label">{(f.label ?? '').trim() || f.fieldKey}</span>
                        <code className="fb-chip__key">{fieldKeyToText(f.fieldKey)}</code>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="fb-palette__group">
                  <span className="fb-palette__label">Operators</span>
                  <div className="fb-palette__chips">
                    {OPERATOR_CHIPS.map((op) => (
                      <button
                        type="button"
                        className="fb-chip fb-chip--op"
                        key={op.text}
                        onClick={() => insertSnippet(op.text)}
                        title={op.title}
                        aria-label={`${op.title} (${op.text})`}
                      >
                        {op.text}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="fb-palette__group">
                  <span className="fb-palette__label">Functions</span>
                  <div className="fb-palette__chips">
                    {FORMULA_FUNCTIONS.map((fn) => (
                      <button
                        type="button"
                        className="fb-chip fb-chip--fn"
                        key={fn.name}
                        onClick={() => insertSnippet(fn.insert)}
                        title={`${fn.signature} — ${fn.description}`}
                      >
                        {fn.name}
                        <span className="fb-chip__paren">(&hellip;)</span>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="fb-palette__group">
                  <span className="fb-palette__label">Conditions</span>
                  <div className="fb-palette__chips">
                    {COMPARE_CHIPS.map((c) => (
                      <button
                        type="button"
                        className={`fb-chip ${isReservedWord(c.text) ? 'fb-chip--kw' : 'fb-chip--op'}`}
                        key={c.text}
                        onClick={() => insertSnippet(c.text)}
                        title={c.title}
                        aria-label={`${c.title} (${c.text})`}
                      >
                        {c.text}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <details className="fb-ref">
                <summary>How to write a formula &mdash; reference &amp; examples</summary>
                <div className="fb-ref__body">
                  <p className="fb-help">
                    Refer to a field by its <strong>field key</strong> (shown on each chip).
                    Use <code>×</code> or <code>*</code>, <code>÷</code> or <code>/</code>,
                    brackets to control the order, a dot for decimals (<code>1.5</code>) and{' '}
                    <code>17%</code> for 0.17. A yes/no toggle is <code>1</code> when on and{' '}
                    <code>0</code> when off; a dropdown is its selected option&rsquo;s value.
                    Multiplication and division happen before addition and subtraction.
                  </p>
                  <table className="fb-ref__table">
                    <caption className="visually-hidden">Common pricing recipes</caption>
                    <thead>
                      <tr>
                        <th scope="col">You want to&hellip;</th>
                        <th scope="col">Write</th>
                      </tr>
                    </thead>
                    <tbody>
                      {RECIPES.map((r) => (
                        <tr key={r.need}>
                          <td>{r.need}</td>
                          <td>
                            <code>{r.formula}</code>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <table className="fb-ref__table">
                    <caption className="visually-hidden">Functions</caption>
                    <thead>
                      <tr>
                        <th scope="col">Function</th>
                        <th scope="col">Does</th>
                        <th scope="col">Example</th>
                      </tr>
                    </thead>
                    <tbody>
                      {FORMULA_FUNCTIONS.map((fn) => (
                        <tr key={fn.name}>
                          <td>
                            <code>{fn.signature}</code>
                          </td>
                          <td>{fn.description}</td>
                          <td>
                            <code>{fn.example}</code>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="fb-help">
                    The examples use field keys such as <code>area</code>, <code>rate</code>,{' '}
                    <code>hours</code> and <code>rush</code> &mdash; use your own service&rsquo;s
                    keys. If the result is zero or negative, visitors see &ldquo;Contact us for a
                    price&rdquo; instead of a number.
                  </p>
                </div>
              </details>
            </>
          )}
        </div>

        {/* --- Tab 2: test / preview --------------------------------------- */}
        <div
          aria-labelledby="fb-tab-test"
          className="fb-panel"
          hidden={tab !== 'test'}
          id="fb-panel-test"
          role="tabpanel"
          tabIndex={0}
        >
          <p className="fb-help">
            Enter sample values to verify the formula produces the expected result
            &mdash; this runs the very same calculation a visitor gets.
          </p>
          {pricingFields.length === 0 ? (
            <p className="fb-note">Add calculator fields to preview a price.</p>
          ) : (
            <div className="fb-preview">
              <div className="fb-preview-inputs">
                {pricingFields.map((f) => (
                  <PreviewInput
                    key={f.fieldKey}
                    field={f}
                    value={sample[f.fieldKey]}
                    missing={missingRequired.some((m) => m.fieldKey === f.fieldKey)}
                    onChange={(v) => setSampleValue(f.fieldKey, v)}
                  />
                ))}
              </div>
              <div className="fb-preview-result">
                {ownError ? (
                  <>
                    <span className="fb-preview-label">Result</span>
                    <span className="fb-preview-amount fb-contact">Fix the formula first</span>
                    <span className="fb-preview-hint">({ownError.message})</span>
                  </>
                ) : !hasAllRequired ? (
                  <>
                    <span className="fb-preview-label">Estimated total</span>
                    <span className="fb-preview-amount fb-contact">
                      Fill the required fields to see a price
                    </span>
                    <span className="fb-preview-hint">
                      (visitors see this until every required field has a value &mdash;
                      matches the live site)
                    </span>
                  </>
                ) : preview.kind === 'price' ? (
                  <>
                    <span className="fb-preview-label">Result</span>
                    <span className="fb-preview-amount">
                      {formatCurrency(preview.total, PREVIEW_LOCALE)}
                    </span>
                    {preview.usedFormula && <span className="fb-preview-tag">via formula</span>}
                  </>
                ) : (
                  <>
                    <span className="fb-preview-label">Result</span>
                    <span className="fb-preview-amount fb-contact">Contact us for a price</span>
                    <span className="fb-preview-hint">
                      (total is zero, negative, or the formula can&rsquo;t be evaluated)
                    </span>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default FormulaBuilder

// ---------------------------------------------------------------------------
// The formula bar: highlighted textarea + autocomplete
// ---------------------------------------------------------------------------

function FormulaInput({
  id,
  describedBy,
  error,
  fields,
  onChange,
  onInsert,
  textareaRef,
  value,
}: {
  id: string
  describedBy: string
  error: ExpressionError | null
  fields: FormulaFieldRef[]
  onChange: (text: string) => void
  onInsert: (snippet: string, range?: [number, number]) => void
  textareaRef: RefObject<HTMLTextAreaElement | null>
  value: string
}) {
  const [caret, setCaret] = useState(0)
  const [ac, setAc] = useState<{ items: Suggestion[]; start: number; active: number } | null>(null)
  const listId = `${id}-ac`

  const tokens = useMemo(() => highlightTokens(value, fields), [value, fields])

  // Auto-grow: the textarea is the real control; the highlight layer sits behind it.
  useLayoutEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = '0px'
    ta.style.height = `${ta.scrollHeight}px`
  }, [value, textareaRef])

  const refreshCaret = () => {
    const ta = textareaRef.current
    if (!ta) return
    setCaret(ta.selectionStart)
  }

  const refreshAutocomplete = (text: string, pos: number) => {
    const s = suggestionsFor(text, pos, fields)
    setAc(s ? { ...s, active: 0 } : null)
  }

  const accept = (item: Suggestion) => {
    if (!ac) return
    onInsert(item.insert, [ac.start, caret])
    setAc(null)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!ac) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setAc({ ...ac, active: (ac.active + 1) % ac.items.length })
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setAc({ ...ac, active: (ac.active - 1 + ac.items.length) % ac.items.length })
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      accept(ac.items[ac.active])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setAc(null)
    }
  }

  // Bracket matching: when the caret touches a bracket, light up its partner.
  const matched = useMemo(() => {
    const at = tokens.findIndex((t) => t.kind === 'paren' && (t.start === caret || t.end === caret))
    if (at === -1) return new Set<number>()
    const other = matchingParen(tokens, at)
    return new Set(other === -1 ? [tokens[at].start] : [tokens[at].start, tokens[other].start])
  }, [tokens, caret])

  // Split the text into styled segments: token kind + error range + bracket match.
  const segments = useMemo(() => {
    const cuts = new Set<number>([0, value.length])
    for (const t of tokens) {
      cuts.add(t.start)
      cuts.add(t.end)
    }
    if (error) {
      cuts.add(Math.min(error.start, value.length))
      cuts.add(Math.min(error.end, value.length))
    }
    const points = [...cuts].sort((a, b) => a - b)
    const out: { text: string; className: string; key: number }[] = []
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i]
      const b = points[i + 1]
      if (a === b) continue
      const tok = tokens.find((t) => t.start <= a && b <= t.end)
      const classes: string[] = []
      if (tok) {
        classes.push(`fb-hl--${tok.kind}`)
        if (tok.kind === 'paren' && matched.has(tok.start)) classes.push('fb-hl--match')
      }
      if (error && a >= error.start && b <= error.end) classes.push('fb-hl--error')
      out.push({ text: value.slice(a, b), className: classes.join(' '), key: a })
    }
    return out
  }, [value, tokens, error, matched])

  const caretError = error && error.start === error.end ? error.start : null

  return (
    <div className={`fb-editor${error ? ' fb-editor--error' : ''}`}>
      <pre className="fb-hl" aria-hidden="true">
        {segments.map((s) =>
          s.className ? (
            <span className={s.className} key={s.key}>
              {s.text}
            </span>
          ) : (
            <span key={s.key}>{s.text}</span>
          ),
        )}
        {caretError !== null && caretError >= value.length && <span className="fb-hl--caret" />}
        {'​'}
      </pre>
      <textarea
        aria-activedescendant={ac ? `${listId}-${ac.active}` : undefined}
        aria-autocomplete="list"
        aria-controls={ac ? listId : undefined}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        className="fb-input"
        id={id}
        onBlur={() => setTimeout(() => setAc(null), 120)}
        onChange={(e) => {
          onChange(e.target.value)
          setCaret(e.target.selectionStart)
          refreshAutocomplete(e.target.value, e.target.selectionStart)
        }}
        onKeyDown={onKeyDown}
        onSelect={refreshCaret}
        placeholder={
          fields.length > 0
            ? `e.g. ${fieldKeyToText(fields[0].fieldKey)} × 12 + 200`
            : 'e.g. area × rate + 200'
        }
        ref={textareaRef}
        rows={1}
        spellCheck={false}
        value={value}
        wrap="soft"
      />
      {ac && (
        <ul className="fb-ac" id={listId} role="listbox" aria-label="Suggestions">
          {ac.items.map((item, i) => (
            <li
              aria-selected={i === ac.active}
              className={`fb-ac__item fb-ac__item--${item.kind}${i === ac.active ? ' is-active' : ''}`}
              id={`${listId}-${i}`}
              key={`${item.kind}-${item.kind === 'field' ? item.key : item.name}`}
              onMouseDown={(e) => {
                e.preventDefault() // keep focus in the textarea
                accept(item)
              }}
              onMouseEnter={() => setAc({ ...ac, active: i })}
              role="option"
            >
              {item.kind === 'field' ? (
                <>
                  <code className="fb-ac__key">{fieldKeyToText(item.key)}</code>
                  <span className="fb-ac__desc">{item.label}</span>
                </>
              ) : item.kind === 'function' ? (
                <>
                  <code className="fb-ac__key">{item.name}(&hellip;)</code>
                  <span className="fb-ac__desc">{item.signature}</span>
                </>
              ) : (
                <code className="fb-ac__key">{item.name}</code>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Preview inputs
// ---------------------------------------------------------------------------

function PreviewInput({
  field,
  value,
  missing,
  onChange,
}: {
  field: PricingField
  value: RawInput
  missing: boolean
  onChange: (v: RawInput) => void
}) {
  return (
    <label className={`fb-preview-field${missing ? ' fb-missing' : ''}`}>
      <span>
        {field.label || field.fieldKey}
        {field.required && (
          <span className="fb-req" aria-hidden="true">
            {' '}
            *
          </span>
        )}
      </span>
      {field.type === 'toggle' ? (
        <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
      ) : field.type === 'dropdown' ? (
        <select value={value === undefined ? '' : String(value)} onChange={(e) => onChange(e.target.value)}>
          {field.options.map((o, i) => (
            <option key={i} value={o.value}>
              {o.label || o.value}
            </option>
          ))}
        </select>
      ) : (
        <span className="fb-preview-number">
          <input
            type="number"
            step="any"
            value={value === undefined || value === null ? '' : String(value)}
            onChange={(e) => onChange(e.target.value)}
            placeholder="0"
            aria-invalid={missing || undefined}
          />
          {field.unit ? <span className="fb-unit">{field.unit}</span> : null}
        </span>
      )}
    </label>
  )
}
