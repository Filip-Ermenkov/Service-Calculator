/**
 * Price-formula expression language (src/lib/pricing/formulaExpression.ts) —
 * pure, no DB. The admin Formula editor compiles what the operator types into
 * JSONLogic, prints stored JSONLogic back to text, and the field `validate`
 * rejects anything the evaluator can't run. These pin all three, plus the
 * extended evaluator operators the language relies on.
 */

import { describe, expect, it } from 'vitest'

import { evaluateJsonLogic, type JsonLogic } from '@/lib/pricing/jsonlogic'
import {
  FORMULA_DRAFT_KEY,
  FORMULA_FUNCTIONS,
  compileExpression,
  describeFormula,
  fieldKeyToText,
  findLogicProblem,
  highlightTokens,
  isFormulaDraft,
  printFormula,
  readStoredFormula,
  toStoredFormula,
  validateStoredFormula,
} from '@/lib/pricing/formulaExpression'
import { computePrice, toPricingFields } from '@/lib/pricing'
import { validateFieldKey, validateFormula } from '@/collections/Services'

const fields = [
  { fieldKey: 'area', label: 'Roof area' },
  { fieldKey: 'rate', label: 'Price per m²' },
  { fieldKey: 'rush', label: 'Rush job' },
  { fieldKey: 'my key', label: 'Odd key' },
]

const compile = (text: string) => compileExpression(text, fields)
const logic = (text: string): JsonLogic => {
  const r = compile(text)
  if (r.error) throw new Error(`unexpected error for "${text}": ${r.error.message}`)
  return r.logic as JsonLogic
}
const err = (text: string): string => {
  const r = compile(text)
  if (!r.error) throw new Error(`expected an error for "${text}"`)
  return r.error.message
}

describe('compileExpression — arithmetic to JSONLogic', () => {
  it('field × field — the case the old structured builder could not express', () => {
    expect(logic('area × rate')).toEqual({ '*': [{ var: 'area' }, { var: 'rate' }] })
    expect(logic('area * rate')).toEqual({ '*': [{ var: 'area' }, { var: 'rate' }] })
  })

  it('applies ordinary precedence and brackets', () => {
    expect(logic('area × rate + 200')).toEqual({ '+': [{ '*': [{ var: 'area' }, { var: 'rate' }] }, 200] })
    expect(logic('area × (rate + 200)')).toEqual({ '*': [{ var: 'area' }, { '+': [{ var: 'rate' }, 200] }] })
    expect(logic('(area + rate) × 2')).toEqual({ '*': [{ '+': [{ var: 'area' }, { var: 'rate' }] }, 2] })
  })

  it('flattens chains of + and × but keeps − and ÷ left-associative and binary', () => {
    expect(logic('1 + 2 + 3')).toEqual({ '+': [1, 2, 3] })
    expect(logic('2 × 3 × area')).toEqual({ '*': [2, 3, { var: 'area' }] })
    expect(logic('10 - 3 - 2')).toEqual({ '-': [{ '-': [10, 3] }, 2] })
    expect(logic('100 / area / 2')).toEqual({ '/': [{ '/': [100, { var: 'area' }] }, 2] })
  })

  it('accepts typographic operators, ; as a separator, and decimals with a dot', () => {
    expect(logic('area ÷ 2 − 1.5')).toEqual({ '-': [{ '/': [{ var: 'area' }, 2] }, 1.5] })
    expect(logic('min(area; rate)')).toEqual({ min: [{ var: 'area' }, { var: 'rate' }] })
    expect(logic('.5 × area')).toEqual({ '*': [0.5, { var: 'area' }] })
  })

  it('unary minus: a negated literal is a negative number, a negated expression is {"-":[x]}', () => {
    expect(logic('-5 + area')).toEqual({ '+': [-5, { var: 'area' }] })
    expect(logic('-area')).toEqual({ '-': [{ var: 'area' }] })
    expect(logic('-(area + 1)')).toEqual({ '-': [{ '+': [{ var: 'area' }, 1] }] })
  })

  it('percent is a postfix shorthand: 17% → 0.17, x% → x ÷ 100', () => {
    // A bracketed product followed by × flattens into one × chain (same arithmetic).
    expect(logic('(area × rate) × (1 + 17%)')).toEqual({
      '*': [{ var: 'area' }, { var: 'rate' }, { '+': [1, 0.17] }],
    })
    expect(logic('area%')).toEqual({ '/': [{ var: 'area' }, 100] })
    expect(logic('-17%')).toBe(-0.17)
  })

  it('braced references reach keys that are not identifier-shaped or are reserved words', () => {
    expect(logic('{my key} × 2')).toEqual({ '*': [{ var: 'my key' }, 2] })
    expect(compileExpression('{min} + 1', [{ fieldKey: 'min' }]).logic).toEqual({ '+': [{ var: 'min' }, 1] })
    expect(fieldKeyToText('roof_area')).toBe('roof_area')
    expect(fieldKeyToText('my key')).toBe('{my key}')
    expect(fieldKeyToText('min')).toBe('{min}')
  })

  it('a blank formula is "no formula", not an error', () => {
    expect(compile('')).toEqual({ logic: null, error: null, empty: true })
    expect(compile('   \n ')).toEqual({ logic: null, error: null, empty: true })
  })
})

describe('compileExpression — conditions and functions', () => {
  it('comparisons (with = and ≠ ≤ ≥ spellings) compile to the JSONLogic operators', () => {
    expect(logic('area > 100')).toEqual({ '>': [{ var: 'area' }, 100] })
    expect(logic('area = 0')).toEqual({ '==': [{ var: 'area' }, 0] })
    expect(logic('area == 0')).toEqual({ '==': [{ var: 'area' }, 0] })
    expect(logic('area != 0')).toEqual({ '!=': [{ var: 'area' }, 0] })
    expect(logic('area ≠ 0')).toEqual({ '!=': [{ var: 'area' }, 0] })
    expect(logic('area <> 0')).toEqual({ '!=': [{ var: 'area' }, 0] })
    expect(logic('area ≤ 5 and rate ≥ 2')).toEqual({
      and: [{ '<=': [{ var: 'area' }, 5] }, { '>=': [{ var: 'rate' }, 2] }],
    })
  })

  it('and / or / not with the expected precedence (not > and > or)', () => {
    expect(logic('rush or area > 1 and rate > 2')).toEqual({
      or: [{ var: 'rush' }, { and: [{ '>': [{ var: 'area' }, 1] }, { '>': [{ var: 'rate' }, 2] }] }],
    })
    expect(logic('not rush and area > 1')).toEqual({
      and: [{ '!': [{ var: 'rush' }] }, { '>': [{ var: 'area' }, 1] }],
    })
    expect(logic('NOT rush')).toEqual({ '!': [{ var: 'rush' }] })
  })

  it('if / min / max / round / ceil / floor / abs / mod', () => {
    expect(logic('if(area > 100, area × 10, area × 12)')).toEqual({
      if: [{ '>': [{ var: 'area' }, 100] }, { '*': [{ var: 'area' }, 10] }, { '*': [{ var: 'area' }, 12] }],
    })
    // else-if chain: condition/value pairs, then the final else.
    expect(logic('if(area > 200, 8, area > 100, 10, 12)')).toEqual({
      if: [{ '>': [{ var: 'area' }, 200] }, 8, { '>': [{ var: 'area' }, 100] }, 10, 12],
    })
    expect(logic('min(area × 12, 5000)')).toEqual({ min: [{ '*': [{ var: 'area' }, 12] }, 5000] })
    expect(logic('MAX(area, 2, rate)')).toEqual({ max: [{ var: 'area' }, 2, { var: 'rate' }] })
    expect(logic('round(area / 3, 2)')).toEqual({ round: [{ '/': [{ var: 'area' }, 3] }, 2] })
    expect(logic('ceil(area / 1.7) × 250')).toEqual({ '*': [{ ceil: [{ '/': [{ var: 'area' }, 1.7] }] }, 250] })
    expect(logic('floor(area)')).toEqual({ floor: [{ var: 'area' }] })
    expect(logic('abs(area - rate)')).toEqual({ abs: [{ '-': [{ var: 'area' }, { var: 'rate' }] }] })
    expect(logic('mod(area, 4)')).toEqual({ '%': [{ var: 'area' }, 4] })
  })

  it('every documented function example compiles (the reference panel is never stale)', () => {
    const exampleFields = ['area', 'hours', 'target', 'actual', 'panels', 'total'].map((k) => ({ fieldKey: k }))
    for (const fn of FORMULA_FUNCTIONS) {
      const r = compileExpression(fn.example, exampleFields)
      expect(r.error, `${fn.name}: ${fn.example}`).toBeNull()
    }
  })
})

describe('compileExpression — plain-language errors with positions', () => {
  it('unknown field, with a suggestion when one is close', () => {
    expect(err('aera × 2')).toMatch(/Unknown field "aera".*Did you mean "area"/)
    expect(err('Area × 2')).toMatch(/Did you mean "area"/)
    // A field's LABEL typed instead of its key is recognised too.
    expect(compileExpression('{Roof area} × 2', fields).error?.message).toMatch(/Did you mean "area"/)
    expect(err('zzz')).toMatch(/Unknown field "zzz".*Fields you can use: area, rate, rush, my key/)
    const r = compile('area + zzz')
    expect([r.error?.start, r.error?.end]).toEqual([7, 10])
  })

  it('missing operands and operators', () => {
    expect(err('area ×')).toMatch(/Something is missing after "×"/)
    expect(err('× area')).toMatch(/Something is missing before/)
    expect(err('12 area')).toMatch(/Missing an operator before "area"/)
    expect(err('area rate')).toMatch(/Missing an operator before "rate"/)
    expect(err('(area)(rate)')).toMatch(/Missing an operator before "\("/)
    expect(err('area + × 2')).toMatch(/Expected a number or field after "\+", not "×"/)
  })

  it('brackets', () => {
    expect(err('(area + 2')).toMatch(/Missing a closing bracket/)
    expect(err('area + 2)')).toMatch(/Unexpected closing bracket/)
    expect(err('()')).toMatch(/Empty brackets/)
    expect(err('area × [2]')).toMatch(/round brackets/)
  })

  it('the decimal comma — the most likely European slip — gets a specific hint', () => {
    expect(err('area × 1,5')).toMatch(/Use a dot for decimals: write "1.5", not "1,5"/)
    expect(err('area, rate')).toMatch(/Unexpected comma/)
  })

  it('functions: arity, missing brackets, keywords out of place', () => {
    expect(err('if(area > 1, 2)')).toMatch(/"if" expects a condition, a value when true and a value when false/)
    expect(err('min(area)')).toMatch(/"min" expects at least two values/)
    expect(err('ceil(area, 2)')).toMatch(/"ceil" expects exactly one value/)
    expect(err('round(area, 2, 3)')).toMatch(/"round" expects one value/)
    expect(err('min area, 2')).toMatch(/"min" needs brackets: min\(a, b, …\)/)
    expect(err('max()')).toMatch(/"max" needs values inside the brackets/)
    expect(err('and area')).toMatch(/Something is missing before "and"/)
    expect(err('area > 1 > 2')).toMatch(/combine them with "and"/)
  })

  it('unsupported characters get a targeted explanation', () => {
    expect(err('area ^ 2')).toMatch(/Powers/)
    expect(err('area × "2"')).toMatch(/Text values are not supported/)
    expect(err('€200 + area')).toMatch(/currency sign/)
    expect(err('area # 2')).toMatch(/Unexpected character "#"/)
  })
})

describe('printFormula / describeFormula — JSONLogic back to text', () => {
  const roundtrip = (text: string, expected = text) => {
    const l = logic(text)
    const printed = printFormula(l)
    expect(printed).toBe(expected)
    // Printing then re-compiling yields the same rule (presentation-only changes).
    expect(logic(printed as string)).toEqual(l)
  }

  it('prints the language’s typographic operators with minimal brackets', () => {
    roundtrip('area × rate + 200')
    roundtrip('area * (rate + 200)', 'area × (rate + 200)')
    roundtrip('(area + rate) × 2')
    roundtrip('10 - 3 - 2', '10 − 3 − 2')
    roundtrip('10 - (3 - 2)', '10 − (3 − 2)')
    roundtrip('100 / (area * 2)', '100 ÷ (area × 2)')
    roundtrip('-(area + 1) × 2', '-(area + 1) × 2')
    roundtrip('area - -5', 'area − (-5)')
    roundtrip('(area × rate) × (1 + 17%)', 'area × rate × (1 + 0.17)')
  })

  it('prints conditions, keywords and functions', () => {
    roundtrip('if(area > 100, area × 10, area × 12)')
    roundtrip('area ≤ 5 and rate ≥ 2 or rush = 1')
    roundtrip('(rush = 1 or area > 5) and not rate ≠ 0')
    roundtrip('min(area × 12, 5000) + ceil(area ÷ 1.7) × 250')
    roundtrip('round(area ÷ 3, 2) + floor(rate) + abs(area − rate) + mod(area, 4)')
    roundtrip('{my key} × 2')
  })

  it('re-opens formulas made by the earlier structured builder', () => {
    // { "*": [ { "+": [ {var}×12, 100 ] }, 1.1 ] }  — "area × 12 + 100, +10% VAT"
    const old: JsonLogic = { '*': [{ '+': [{ '*': [{ var: 'area' }, 12] }, 100] }, 1.1] }
    expect(printFormula(old)).toBe('(area × 12 + 100) × 1.1')
    // A single-term subtotal and a subtract-group with the trailing −1 factor.
    expect(printFormula({ '+': [{ '*': [{ var: 'area' }, 12] }] })).toBe('area × 12')
    expect(printFormula({ '*': [{ '+': [{ var: 'area' }, 50] }, 3, -1] })).toBe('(area + 50) × 3 × (-1)')
  })

  it('returns null for JSONLogic the language cannot spell (⇒ raw-JSON view)', () => {
    expect(printFormula({ '<': [1, { var: 'area' }, 3] })).toBeNull()
    expect(printFormula({ '!!': [{ var: 'area' }] })).toBeNull()
    expect(printFormula({ var: ['area', 5] })).toBeNull()
    expect(printFormula({ cat: ['a', 'b'] })).toBeNull()
    expect(printFormula({ [FORMULA_DRAFT_KEY]: 'area ×' })).toBeNull()
  })

  it('describeFormula swaps keys for the visible labels', () => {
    expect(describeFormula(logic('area × rate + 200'), fields)).toBe('Roof area × Price per m² + 200')
    expect(describeFormula(logic('{my key} + 1'), fields)).toBe('Odd key + 1')
  })

  it('numbers never print in exponent notation', () => {
    expect(printFormula(0.0000001)).toBe('0.0000001')
    expect(printFormula(1e21)).toBe('1000000000000000000000')
  })
})

describe('stored value: JSONLogic | draft marker | null', () => {
  it('toStoredFormula: JSONLogic when valid, null when blank, a draft marker when broken', () => {
    expect(toStoredFormula('area × 2', fields)).toEqual({ value: { '*': [{ var: 'area' }, 2] }, error: null })
    expect(toStoredFormula('  ', fields)).toEqual({ value: null, error: null })
    const broken = toStoredFormula('area ×', fields)
    expect(isFormulaDraft(broken.value)).toBe(true)
    expect(broken.value).toEqual({ [FORMULA_DRAFT_KEY]: 'area ×' })
    expect(broken.error?.message).toMatch(/Something is missing after "×"/)
  })

  it('readStoredFormula: draft text, printed text, "" for empty, null for unprintable', () => {
    expect(readStoredFormula(null)).toBe('')
    expect(readStoredFormula({})).toBe('')
    expect(readStoredFormula({ [FORMULA_DRAFT_KEY]: 'area ×' })).toBe('area ×')
    expect(readStoredFormula({ '*': [{ var: 'area' }, 2] })).toBe('area × 2')
    expect(readStoredFormula({ cat: ['a'] })).toBeNull()
  })

  it('a draft marker never prices: the evaluator rejects it ⇒ "Contact us"', () => {
    const pf = toPricingFields([{ fieldKey: 'area', label: 'Area', type: 'number', unitPrice: 10, sign: 'add' }])
    const r = computePrice({ fields: pf, formula: { [FORMULA_DRAFT_KEY]: 'area ×' }, inputs: { area: 5 } })
    expect(r.kind).toBe('contact')
  })
})

describe('validateStoredFormula (the Payload field validate)', () => {
  it('accepts empty and well-formed formulas over existing fields', () => {
    expect(validateStoredFormula(null, fields)).toBe(true)
    expect(validateStoredFormula({}, fields)).toBe(true)
    expect(validateStoredFormula(logic('if(area > 1, area × rate, 5)'), fields)).toBe(true)
  })

  it('rejects the draft marker with the real parse problem', () => {
    expect(validateStoredFormula({ [FORMULA_DRAFT_KEY]: 'area ×' }, fields)).toMatch(
      /^The price formula has an error: Something is missing after "×"/,
    )
    // A draft whose text became valid (a field was added later) is still a draft.
    expect(validateStoredFormula({ [FORMULA_DRAFT_KEY]: 'area × 2' }, fields)).toMatch(/unfinished draft/)
  })

  it('rejects references to fields that no longer exist — e.g. a renamed field key', () => {
    expect(validateStoredFormula({ '*': [{ var: 'gone' }, 2] }, fields)).toMatch(
      /uses "gone", which is not one of this service's calculator fields \(available: area, rate, rush, my key\)/,
    )
  })

  it('rejects anything the evaluator would throw on (unsupported ops, bad arity, text)', () => {
    expect(findLogicProblem({ cat: ['a', 'b'] }, [])).toMatch(/unsupported operation "cat"/)
    expect(findLogicProblem({ '/': [1] }, [])).toMatch(/gives "\/" 1 value where exactly 2 are expected/)
    expect(findLogicProblem({ '+': [1, 'x'] }, [])).toMatch(/text value "x"/)
    expect(findLogicProblem({ '+': [1], '*': [2] }, [])).toMatch(/more than one operator/)
    expect(findLogicProblem({ '+': [1, 2] }, [])).toBeNull()
  })
})

describe('highlightTokens (editor syntax colouring)', () => {
  it('classifies fields, unknowns, numbers, functions, keywords, brackets with depth', () => {
    const toks = highlightTokens('if(area > 1 and zzz, (2 + 3) × 17%, 0)', fields)
    const kinds = toks.map((t) => `${t.kind}:${t.text}`)
    expect(kinds).toEqual([
      'function:if',
      'paren:(',
      'field:area',
      'operator:>',
      'number:1',
      'keyword:and',
      'unknown:zzz',
      'comma:,',
      'paren:(',
      'number:2',
      'operator:+',
      'number:3',
      'paren:)',
      'operator:×',
      'number:17',
      'percent:%',
      'comma:,',
      'number:0',
      'paren:)',
    ])
    const parens = toks.filter((t) => t.kind === 'paren').map((t) => t.depth)
    expect(parens).toEqual([0, 1, 1, 0])
  })

  it('never throws on broken input — the bad span is marked invalid', () => {
    const toks = highlightTokens('area ^ 2', fields)
    expect(toks.map((t) => t.kind)).toEqual(['field', 'invalid', 'number'])
  })
})

describe('evaluateJsonLogic — the operators the language compiles to', () => {
  const run = (text: string, data: Record<string, number>) => evaluateJsonLogic(logic(text), data)

  it('field × field and mixed arithmetic', () => {
    expect(run('area × rate + 200', { area: 10, rate: 12 })).toBe(320)
    expect(run('(area × rate) × (1 + 17%)', { area: 10, rate: 10 })).toBeCloseTo(117, 9)
  })

  it('comparisons return 1/0; and/or follow JSONLogic value semantics; if is lazy', () => {
    expect(run('area > 100', { area: 150 })).toBe(1)
    expect(run('area > 100', { area: 50 })).toBe(0)
    expect(run('(area > 5) × 100', { area: 6 })).toBe(100)
    expect(evaluateJsonLogic({ and: [1, 2] }, {})).toBe(2)
    expect(evaluateJsonLogic({ and: [1, 0, 2] }, {})).toBe(0)
    expect(evaluateJsonLogic({ or: [0, 3] }, {})).toBe(3)
    expect(run('not rush', { rush: 1 })).toBe(0)
    // The untaken branch divides by zero — irrelevant because `if` is lazy.
    expect(run('if(rate = 0, 0, area / rate)', { area: 10, rate: 0 })).toBe(0)
    expect(run('if(area > 200, 8, area > 100, 10, 12)', { area: 150 })).toBe(10)
    expect(run('if(area > 200, 8, area > 100, 10, 12)', { area: 50 })).toBe(12)
  })

  it('rounding family and mod', () => {
    expect(run('round(area / 3)', { area: 10 })).toBe(3)
    expect(run('round(area / 3, 2)', { area: 10 })).toBe(3.33)
    expect(run('round(1.005, 2)', {})).toBe(1.01) // float-dust guard
    expect(run('round(-2.5)', {})).toBe(-3) // half away from zero
    expect(run('ceil(area / 1.7)', { area: 10 })).toBe(6)
    expect(run('floor(area / 1.7)', { area: 10 })).toBe(5)
    expect(run('abs(area - rate)', { area: 3, rate: 10 })).toBe(7)
    expect(run('mod(area, 4)', { area: 10 })).toBe(2)
  })

  it('standard 3-arg "between" comparisons still evaluate (raw JSON authors)', () => {
    expect(evaluateJsonLogic({ '<': [1, 2, 3] }, {})).toBe(1)
    expect(evaluateJsonLogic({ '<=': [1, 1, 0] }, {})).toBe(0)
  })

  it('throws on wrong arity so computePrice falls back to "contact"', () => {
    expect(() => evaluateJsonLogic({ '/': [1] }, {})).toThrow()
    expect(() => evaluateJsonLogic({ ceil: [1, 2] }, {})).toThrow()
    expect(() => evaluateJsonLogic({ [FORMULA_DRAFT_KEY]: 'x' } as never, {})).toThrow()
  })
})

describe('Services field validators (src/collections/Services.ts)', () => {
  // The Payload `validate` wiring: the formula check reads the calculator fields
  // off the document data, and field keys must be unique and space-free.
  const opts = (data: unknown) =>
    ({ data, siblingData: {}, required: true, req: { payload: { config: {} }, t: (k: string) => k } }) as never

  it('validateFormula resolves the field keys from data.calculatorFields', async () => {
    const data = { calculatorFields: [{ fieldKey: 'area', label: 'Area' }] }
    expect(await validateFormula({ '*': [{ var: 'area' }, 2] } as never, opts(data))).toBe(true)
    expect(await validateFormula({ '*': [{ var: 'rate' }, 2] } as never, opts(data))).toMatch(/uses "rate"/)
    expect(await validateFormula({ [FORMULA_DRAFT_KEY]: 'area ×' } as never, opts(data))).toMatch(
      /has an error: Something is missing after "×"/,
    )
    expect(await validateFormula(null, opts(data))).toBe(true)
  })

  it('validateFieldKey rejects blanks, spaces, braces and duplicates', async () => {
    const rows = { calculatorFields: [{ fieldKey: 'area' }, { fieldKey: 'area' }, { fieldKey: 'rate' }] }
    expect(await validateFieldKey('rate', opts(rows))).toBe(true)
    expect(await validateFieldKey('area', opts(rows))).toMatch(/already uses the key "area"/)
    expect(await validateFieldKey('roof area', opts(rows))).toMatch(/cannot contain spaces/)
    expect(await validateFieldKey('{x}', opts(rows))).toMatch(/cannot contain \{ or \}/)
    // The default text rules still run first (required).
    expect(await validateFieldKey('', opts(rows))).not.toBe(true)
  })
})
