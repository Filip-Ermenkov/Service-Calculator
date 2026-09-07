'use client'

/**
 * Formula Builder — custom admin field for the Services `formula` field
 * (Phase 3 part 2 — TECHSPEC §6.4, FUNCTIONALITY §5.3).
 *
 * A non-technical, structured UI for assembling a pricing formula: field terms
 * (field × multiplier, + or −), fixed costs, groupings ("(A + B) × C") and
 * percentage adjustments (e.g. +10% VAT). It compiles to the SAME JSONLogic the
 * public calculator + shared evaluator (`src/lib/pricing/`) already run, so what
 * the operator builds is exactly what visitors get. A **live preview** panel
 * feeds sample inputs through the very same `computePrice()` the public page
 * uses (preview == production, by construction).
 *
 * The stored value is always plain JSONLogic (never the builder's own model), so
 * nothing downstream changes and no migration is needed. Anything hand-authored
 * outside the builder's canonical shape is detected and shown in a raw-JSON
 * editor instead — nothing is ever locked out.
 */

import { useMemo, useState, type KeyboardEvent } from 'react'
import { useAllFormFields, useField } from '@payloadcms/ui'
import { reduceFieldsToValues } from 'payload/shared'

import {
  compileFormula,
  parseFormula,
  emptyFormula,
  type BuilderAdjustment,
  type BuilderFormula,
  type BuilderTerm,
  type GroupMember,
  type Sign,
} from '@/lib/pricing/formulaBuilder'
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
// Small presentational helpers
// ---------------------------------------------------------------------------

function num(v: string): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function SignToggle({ value, onChange }: { value: Sign; onChange: (s: Sign) => void }) {
  return (
    <div className="fb-sign" role="group" aria-label="Sign">
      <button
        type="button"
        className={value === 'add' ? 'is-active' : ''}
        onClick={() => onChange('add')}
        aria-pressed={value === 'add'}
        title="Adds to the price"
      >
        +
      </button>
      <button
        type="button"
        className={value === 'subtract' ? 'is-active' : ''}
        onClick={() => onChange('subtract')}
        aria-pressed={value === 'subtract'}
        title="Subtracts from the price"
      >
        −
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Formula canvas — a read-only picture of the formula being built
// ---------------------------------------------------------------------------

/**
 * The prototype's dark "current formula" strip: the structured model rendered as
 * colour-coded tokens, so the operator can *see* the arithmetic they assembled
 * without reading JSON. Purely derived from `model` — there is no second source
 * of truth and nothing here can drift from what gets compiled and stored.
 */
type CanvasToken = {
  kind: 'field' | 'fixed' | 'num' | 'op' | 'pct'
  text: string
  title?: string
}

function formulaTokens(model: BuilderFormula, fields: PricingField[]): CanvasToken[] {
  const labelOf = (key: string) =>
    fields.find((f) => f.fieldKey === key)?.label || key || '(no field)'
  const out: CanvasToken[] = []
  const op = (text: string) => out.push({ kind: 'op', text })
  const fieldToken = (key: string, multiplier: number) => {
    out.push({ kind: 'field', text: (key || '?').toUpperCase(), title: labelOf(key) })
    if (multiplier !== 1) {
      op('×')
      out.push({ kind: 'num', text: String(multiplier), title: 'Multiplier' })
    }
  }

  model.terms.forEach((term, i) => {
    if (term.sign === 'subtract') op('−')
    else if (i > 0) op('+')

    if (term.kind === 'field') {
      fieldToken(term.fieldKey, term.multiplier)
      return
    }
    if (term.kind === 'fixed') {
      out.push({
        kind: 'fixed',
        text: `€${Math.abs(term.amount)}`,
        title: 'Fixed cost',
      })
      return
    }
    // group: ( member + member ) × factor
    op('(')
    term.members.forEach((m, j) => {
      if (j > 0) op('+')
      if (m.kind === 'field') fieldToken(m.fieldKey, m.multiplier)
      else out.push({ kind: 'fixed', text: `€${m.amount}`, title: 'Fixed cost' })
    })
    op(')')
    const usesField = term.factorType === 'field'
    if (usesField || term.factorConstant !== 1) {
      op('×')
      if (usesField) {
        out.push({
          kind: 'field',
          text: (term.factorField || '?').toUpperCase(),
          title: labelOf(term.factorField),
        })
      } else {
        out.push({ kind: 'num', text: String(term.factorConstant), title: 'Factor' })
      }
    }
  })

  model.adjustments.forEach((adj) => {
    const signed = adj.sign === 'subtract' ? -adj.percent : adj.percent
    const factor = Math.round((1 + signed / 100) * 1e6) / 1e6
    op('×')
    out.push({
      kind: 'pct',
      text: String(factor),
      title: `${adj.label || 'Adjustment'} ${signed >= 0 ? '+' : '−'}${Math.abs(adj.percent)}%`,
    })
  })

  return out
}

function FormulaCanvas({
  fields,
  model,
}: {
  fields: PricingField[]
  model: BuilderFormula
}) {
  const tokens = useMemo(() => formulaTokens(model, fields), [model, fields])

  if (tokens.length === 0) {
    return (
      <div className="fb-canvas fb-canvas--empty">
        No formula yet — the price is the sum of each field&rsquo;s own unit price.
      </div>
    )
  }

  // One readable string for assistive tech, instead of a stream of loose tokens.
  return (
    <div
      aria-label={`Current formula: ${tokens.map((t) => t.text).join(' ')}`}
      className="fb-canvas"
      role="img"
    >
      {tokens.map((t, i) => (
        <span className={`fb-token fb-token--${t.kind}`} key={i} title={t.title}>
          {t.text}
        </span>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export const FormulaBuilder = ({ path = 'formula' }: Props) => {
  const { value, setValue } = useField<JsonLogic | null>({ path })
  const [allFields] = useAllFormFields()

  // Live list of the service's calculator fields (from sibling form state).
  const pricingFields: PricingField[] = useMemo(() => {
    const data = reduceFieldsToValues(allFields, true) as {
      calculatorFields?: unknown
    }
    return toPricingFields(
      (data.calculatorFields as Parameters<typeof toPricingFields>[0]) ?? [],
    )
  }, [allFields])

  // Initialise the builder model / mode once from the stored value.
  const [model, setModel] = useState<BuilderFormula>(() => {
    const parsed = parseFormula(value)
    return parsed ?? emptyFormula()
  })
  const [mode, setMode] = useState<'builder' | 'raw'>(() =>
    parseFormula(value) === null ? 'raw' : 'builder',
  )
  const [rawText, setRawText] = useState<string>(() =>
    value ? JSON.stringify(value, null, 2) : '',
  )
  const [rawError, setRawError] = useState<string | null>(null)

  // Sample values for the live preview (fieldKey → raw form value).
  const [sample, setSample] = useState<Record<string, RawInput>>({})

  // Which builder tab is showing (composition ⟷ test/preview).
  const [tab, setTab] = useState<'compose' | 'test'>('compose')

  // Commit a new builder model: update local state + the stored JSONLogic value.
  const commit = (next: BuilderFormula) => {
    setModel(next)
    setValue(compileFormula(next))
  }

  // --- term mutators -------------------------------------------------------
  const firstFieldKey = pricingFields[0]?.fieldKey ?? ''

  const addFieldTerm = () =>
    commit({
      ...model,
      terms: [
        ...model.terms,
        { kind: 'field', sign: 'add', fieldKey: firstFieldKey, multiplier: 1 },
      ],
    })
  const addFixedTerm = () =>
    commit({
      ...model,
      terms: [...model.terms, { kind: 'fixed', sign: 'add', amount: 0 }],
    })
  const addGroupTerm = () =>
    commit({
      ...model,
      terms: [
        ...model.terms,
        {
          kind: 'group',
          sign: 'add',
          members: [{ kind: 'field', fieldKey: firstFieldKey, multiplier: 1 }],
          factorType: 'constant',
          factorConstant: 1,
          factorField: '',
        },
      ],
    })

  const updateTerm = (i: number, t: BuilderTerm) => {
    const terms = model.terms.slice()
    terms[i] = t
    commit({ ...model, terms })
  }
  const removeTerm = (i: number) =>
    commit({ ...model, terms: model.terms.filter((_, j) => j !== i) })
  const moveTerm = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= model.terms.length) return
    const terms = model.terms.slice()
    ;[terms[i], terms[j]] = [terms[j], terms[i]]
    commit({ ...model, terms })
  }

  // --- adjustment mutators -------------------------------------------------
  const addAdjustment = () =>
    commit({
      ...model,
      adjustments: [
        ...model.adjustments,
        { sign: 'add', percent: 10, label: 'VAT' },
      ],
    })
  const updateAdjustment = (i: number, a: BuilderAdjustment) => {
    const adjustments = model.adjustments.slice()
    adjustments[i] = a
    commit({ ...model, adjustments })
  }
  const removeAdjustment = (i: number) =>
    commit({ ...model, adjustments: model.adjustments.filter((_, j) => j !== i) })
  const moveAdjustment = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= model.adjustments.length) return
    const adjustments = model.adjustments.slice()
    ;[adjustments[i], adjustments[j]] = [adjustments[j], adjustments[i]]
    commit({ ...model, adjustments })
  }

  const clearAll = () => {
    commit(emptyFormula())
    setRawText('')
    setRawError(null)
  }

  // --- raw-mode handlers ---------------------------------------------------
  const applyRaw = (text: string) => {
    setRawText(text)
    if (text.trim() === '') {
      setRawError(null)
      setValue(null)
      return
    }
    try {
      const parsed = JSON.parse(text) as JsonLogic
      setRawError(null)
      setValue(parsed)
    } catch {
      setRawError('Not valid JSON — the last valid value is still saved.')
    }
  }

  const switchToBuilder = () => {
    const parsed = parseFormula(value)
    if (parsed === null) {
      const ok = window.confirm(
        'This formula was not created with the visual builder and cannot be ' +
          'shown in it without change. Switch anyway and start from an empty ' +
          'builder? (The current raw formula will be replaced when you edit.)',
      )
      if (!ok) return
      setModel(emptyFormula())
      setValue(null)
    } else {
      setModel(parsed)
    }
    setMode('builder')
  }

  const switchToRaw = () => {
    setRawText(value ? JSON.stringify(value, null, 2) : '')
    setRawError(null)
    setMode('raw')
  }

  // --- live preview --------------------------------------------------------
  const preview = useMemo(() => {
    const inputs = coerceInputs(pricingFields, sample)
    return computePrice({
      fields: pricingFields,
      formula: value ?? null,
      inputs,
    })
  }, [pricingFields, sample, value])

  // Mirror the public calculator's required-field gating EXACTLY so the preview
  // matches production: the total is withheld until every required number field
  // has a value. An explicit 0 counts as filled; only an untouched/blank field
  // is "missing" (dropdowns/toggles always carry a value, so only number-type
  // fields can be missing). See ServiceCalculator.tsx.
  const missingRequired = useMemo(
    () =>
      pricingFields.filter(
        (f) =>
          f.required &&
          f.type === 'number' &&
          (sample[f.fieldKey] === '' ||
            sample[f.fieldKey] === null ||
            sample[f.fieldKey] === undefined),
      ),
    [pricingFields, sample],
  )
  const hasAllRequired = missingRequired.length === 0

  const setSampleValue = (key: string, v: RawInput) =>
    setSample((prev) => ({ ...prev, [key]: v }))

  // -------------------------------------------------------------------------

  const TABS = [
    { id: 'compose', label: 'Formula Composition' },
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

  return (
    <div className="fb field-type">
      <div className="fb-head">
        {/* The section header above already reads "Price Formula Builder", so the
            field's own label is for assistive tech only. */}
        <label className="field-label visually-hidden">Price formula</label>
        <div className="fb-modes">
          {mode === 'builder' ? (
            <button type="button" className="fb-link" onClick={switchToRaw}>
              Edit raw JSON
            </button>
          ) : (
            <button type="button" className="fb-link" onClick={switchToBuilder}>
              Use visual builder
            </button>
          )}
        </div>
      </div>

      <p className="fb-help">
        Define exactly how the fields above combine to produce the final price.
        Leave it empty to simply add up each field&rsquo;s own unit price. Terms
        are summed top to bottom, then each percentage adjustment is applied in
        turn.
      </p>

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

        {/* --- Tab 1: composition ------------------------------------------ */}
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
              />
              {rawError && <p className="fb-error">{rawError}</p>}
              <p className="fb-help">
                Advanced: a JSONLogic rule using only <code>var</code>,{' '}
                <code>+ &minus; &times; &divide;</code>, <code>min</code>,{' '}
                <code>max</code>. Anything else renders as &ldquo;Contact us for
                a price&rdquo;.
              </p>
            </div>
          ) : (
            <>
              <div className="fb-canvas-label">Current formula</div>
              <FormulaCanvas fields={pricingFields} model={model} />

              {pricingFields.length === 0 && (
                <p className="fb-note">
                  No calculator fields yet. Add fields above first &mdash; then
                  reference them here. You can still add fixed costs.
                </p>
              )}

              <div className="fb-section">
                <h4>Terms (summed)</h4>
                {model.terms.length === 0 && <p className="fb-note">No terms yet.</p>}
                {model.terms.map((term, i) => (
                  <TermRow
                    key={i}
                    term={term}
                    index={i}
                    total={model.terms.length}
                    fields={pricingFields}
                    onChange={(t) => updateTerm(i, t)}
                    onRemove={() => removeTerm(i)}
                    onMove={(dir) => moveTerm(i, dir)}
                  />
                ))}
                <div className="fb-add">
                  <button type="button" onClick={addFieldTerm}>
                    + Field term
                  </button>
                  <button type="button" onClick={addFixedTerm}>
                    + Fixed cost
                  </button>
                  <button type="button" onClick={addGroupTerm}>
                    + Group (&hellip;)
                  </button>
                </div>
              </div>

              {model.terms.length > 0 && (
                <button type="button" className="fb-clear" onClick={clearAll}>
                  Clear formula
                </button>
              )}
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
            Enter sample values to verify the formula produces the expected
            result &mdash; this runs the very same calculation a visitor gets.
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
                {!hasAllRequired ? (
                  <>
                    <span className="fb-preview-label">Estimated total</span>
                    <span className="fb-preview-amount fb-contact">
                      Fill the required fields to see a price
                    </span>
                    <span className="fb-preview-hint">
                      (visitors see this until every required field has a value
                      &mdash; matches the live site)
                    </span>
                  </>
                ) : preview.kind === 'price' ? (
                  <>
                    <span className="fb-preview-label">
                      Result (incl. adjustments)
                    </span>
                    <span className="fb-preview-amount">
                      {formatCurrency(preview.total, PREVIEW_LOCALE)}
                    </span>
                    {preview.usedFormula && (
                      <span className="fb-preview-tag">via formula</span>
                    )}
                  </>
                ) : (
                  <>
                    <span className="fb-preview-label">Result</span>
                    <span className="fb-preview-amount fb-contact">
                      Contact us for a price
                    </span>
                    <span className="fb-preview-hint">
                      (total is zero, negative, or the formula can&rsquo;t be
                      evaluated)
                    </span>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* --- Fixed costs & adjustments ------------------------------------- */}
      {mode === 'builder' && (
        <div className="fb-fixed">
          <div className="fb-fixed-title">Fixed Costs &amp; Adjustments</div>
          <p className="fb-note">
            Percentages applied to the subtotal, in order &mdash; VAT, a
            discount, a surcharge. A flat amount that is always added or
            subtracted is a &ldquo;Fixed cost&rdquo; term in the composition
            above.
          </p>
          {model.adjustments.map((adj, i) => (
            <div className="fb-row fb-adj" key={i}>
              <SignToggle
                value={adj.sign}
                onChange={(s) => updateAdjustment(i, { ...adj, sign: s })}
              />
              <input
                className="fb-num"
                type="number"
                step="any"
                value={adj.percent}
                onChange={(e) =>
                  updateAdjustment(i, { ...adj, percent: num(e.target.value) })
                }
                aria-label="Percentage"
              />
              <span className="fb-pct">%</span>
              <input
                className="fb-text"
                type="text"
                value={adj.label}
                placeholder="Label (e.g. VAT)"
                onChange={(e) =>
                  updateAdjustment(i, { ...adj, label: e.target.value })
                }
                aria-label="Adjustment label"
              />
              <RowControls
                index={i}
                total={model.adjustments.length}
                onMove={(dir) => moveAdjustment(i, dir)}
                onRemove={() => removeAdjustment(i)}
              />
            </div>
          ))}
          <div className="fb-add">
            <button type="button" onClick={addAdjustment}>
              + Percentage adjustment
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default FormulaBuilder

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function RowControls({
  index,
  total,
  onMove,
  onRemove,
}: {
  index: number
  total: number
  onMove: (dir: -1 | 1) => void
  onRemove: () => void
}) {
  return (
    <div className="fb-controls">
      <button
        type="button"
        onClick={() => onMove(-1)}
        disabled={index === 0}
        aria-label="Move up"
        title="Move up"
      >
        ↑
      </button>
      <button
        type="button"
        onClick={() => onMove(1)}
        disabled={index === total - 1}
        aria-label="Move down"
        title="Move down"
      >
        ↓
      </button>
      <button
        type="button"
        className="fb-remove"
        onClick={onRemove}
        aria-label="Remove"
        title="Remove"
      >
        ✕
      </button>
    </div>
  )
}

function FieldSelect({
  value,
  fields,
  onChange,
  ariaLabel,
}: {
  value: string
  fields: PricingField[]
  onChange: (key: string) => void
  ariaLabel: string
}) {
  return (
    <select
      className="fb-select"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={ariaLabel}
    >
      {fields.length === 0 && <option value="">(no fields)</option>}
      {fields.map((f) => (
        <option key={f.fieldKey} value={f.fieldKey}>
          {f.label || f.fieldKey}
        </option>
      ))}
    </select>
  )
}

function TermRow({
  term,
  index,
  total,
  fields,
  onChange,
  onRemove,
  onMove,
}: {
  term: BuilderTerm
  index: number
  total: number
  fields: PricingField[]
  onChange: (t: BuilderTerm) => void
  onRemove: () => void
  onMove: (dir: -1 | 1) => void
}) {
  return (
    <div className="fb-row fb-term">
      <SignToggle value={term.sign} onChange={(s) => onChange({ ...term, sign: s })} />

      {term.kind === 'field' && (
        <>
          <FieldSelect
            value={term.fieldKey}
            fields={fields}
            ariaLabel="Field"
            onChange={(key) => onChange({ ...term, fieldKey: key })}
          />
          <span className="fb-op">×</span>
          <input
            className="fb-num"
            type="number"
            step="any"
            value={term.multiplier}
            onChange={(e) => onChange({ ...term, multiplier: num(e.target.value) })}
            aria-label="Multiplier"
          />
        </>
      )}

      {term.kind === 'fixed' && (
        <>
          <span className="fb-op">€</span>
          <input
            className="fb-num"
            type="number"
            step="any"
            value={term.amount}
            onChange={(e) => onChange({ ...term, amount: num(e.target.value) })}
            aria-label="Fixed amount"
          />
          <span className="fb-tag">fixed cost</span>
        </>
      )}

      {term.kind === 'group' && (
        <GroupEditor term={term} fields={fields} onChange={onChange} />
      )}

      <RowControls index={index} total={total} onMove={onMove} onRemove={onRemove} />
    </div>
  )
}

function GroupEditor({
  term,
  fields,
  onChange,
}: {
  term: Extract<BuilderTerm, { kind: 'group' }>
  fields: PricingField[]
  onChange: (t: BuilderTerm) => void
}) {
  const firstKey = fields[0]?.fieldKey ?? ''
  const setMember = (i: number, m: GroupMember) => {
    const members = term.members.slice()
    members[i] = m
    onChange({ ...term, members })
  }
  const addMember = () =>
    onChange({
      ...term,
      members: [...term.members, { kind: 'field', fieldKey: firstKey, multiplier: 1 }],
    })
  const removeMember = (i: number) =>
    onChange({ ...term, members: term.members.filter((_, j) => j !== i) })

  return (
    <div className="fb-group">
      <span className="fb-op">(</span>
      <div className="fb-group-members">
        {term.members.map((m, i) => (
          <div className="fb-member" key={i}>
            {i > 0 && <span className="fb-op">+</span>}
            {m.kind === 'field' ? (
              <>
                <FieldSelect
                  value={m.fieldKey}
                  fields={fields}
                  ariaLabel="Group field"
                  onChange={(key) => setMember(i, { ...m, fieldKey: key })}
                />
                <span className="fb-op">×</span>
                <input
                  className="fb-num"
                  type="number"
                  step="any"
                  value={m.multiplier}
                  onChange={(e) =>
                    setMember(i, { ...m, multiplier: num(e.target.value) })
                  }
                  aria-label="Group member multiplier"
                />
              </>
            ) : (
              <input
                className="fb-num"
                type="number"
                step="any"
                value={m.amount}
                onChange={(e) => setMember(i, { kind: 'fixed', amount: num(e.target.value) })}
                aria-label="Group member amount"
              />
            )}
            <button
              type="button"
              className="fb-remove fb-remove-sm"
              onClick={() => removeMember(i)}
              aria-label="Remove group member"
              disabled={term.members.length <= 1}
            >
              ✕
            </button>
          </div>
        ))}
        <button type="button" className="fb-link" onClick={addMember}>
          + add to group
        </button>
      </div>
      <span className="fb-op">)</span>
      <span className="fb-op">×</span>
      <select
        className="fb-select fb-factor-type"
        value={term.factorType}
        onChange={(e) =>
          onChange({
            ...term,
            factorType: e.target.value as 'constant' | 'field',
          })
        }
        aria-label="Multiply group by"
      >
        <option value="constant">number</option>
        <option value="field">field</option>
      </select>
      {term.factorType === 'constant' ? (
        <input
          className="fb-num"
          type="number"
          step="any"
          value={term.factorConstant}
          onChange={(e) => onChange({ ...term, factorConstant: num(e.target.value) })}
          aria-label="Group multiplier constant"
        />
      ) : (
        <FieldSelect
          value={term.factorField}
          fields={fields}
          ariaLabel="Group multiplier field"
          onChange={(key) => onChange({ ...term, factorField: key })}
        />
      )}
    </div>
  )
}

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
        {field.required && <span className="fb-req" aria-hidden="true"> *</span>}
      </span>
      {field.type === 'toggle' ? (
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
      ) : field.type === 'dropdown' ? (
        <select
          value={value === undefined ? '' : String(value)}
          onChange={(e) => onChange(e.target.value)}
        >
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
