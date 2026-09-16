'use client'

/**
 * The two Services-only summary columns from the prototype's Services table
 * (/prototype/admin/services.html), rendered as `Cell`s of list-only `ui`
 * fields on the Services collection:
 *
 *   • Home Page Card — "Photo set · Card text set": whether the Home tile has
 *     an image (card photo or hero fallback) and any card copy.
 *   • Calculator Fields — "3 fields defined": how many calculator inputs the
 *     service's price estimator carries.
 *
 * Both read straight off the list row (`rowData`), which Payload loads at
 * depth 0: uploads arrive as ids, arrays as arrays — exactly enough to count and
 * to tell "set" from "not set" without a second request per row.
 */

type ServiceRow = {
  heroImage?: unknown
  card?: { cardTitle?: unknown; cardDescription?: unknown; cardImage?: unknown } | null
  calculatorFields?: unknown
}

function hasUpload(v: unknown): boolean {
  return typeof v === 'number' || typeof v === 'string' || (typeof v === 'object' && v !== null)
}
function hasText(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0
}

export const HomeCardCell = ({ rowData }: { rowData?: ServiceRow }) => {
  const card = rowData?.card ?? {}
  const photo = hasUpload(card.cardImage) || hasUpload(rowData?.heroImage)
  const text = hasText(card.cardTitle) || hasText(card.cardDescription)
  return (
    <span className="acell-meta">
      {photo ? 'Photo set' : 'No photo'} · {text ? 'Card text set' : 'No card text'}
    </span>
  )
}

export const CalculatorFieldsCell = ({ rowData }: { rowData?: ServiceRow }) => {
  const n = Array.isArray(rowData?.calculatorFields) ? rowData.calculatorFields.length : 0
  return (
    <span className="acell-meta">
      {n === 0 ? 'No calculator' : `${n} ${n === 1 ? 'field' : 'fields'} defined`}
    </span>
  )
}
