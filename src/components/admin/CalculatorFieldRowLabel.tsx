'use client'

/**
 * Row header for each entry of `Services.calculatorFields` — the prototype's
 * `.field-block-drag` bar (/prototype/admin/service-editor.html): the field's
 * own label followed by a colour-coded badge naming its input type.
 *
 * Wired via the array field's `admin.components.RowLabel`. `useRowLabel()` gives
 * this row's live form data, so the header updates as the admin types the label
 * or switches the type — no save needed. Payload still owns the row itself
 * (drag handle, collapse, duplicate/remove), so only the label is ours.
 */

import { useRowLabel } from '@payloadcms/ui'

type Row = {
  fieldKey?: string
  label?: string
  type?: 'dropdown' | 'number' | 'toggle'
}

const BADGES = {
  number: { label: 'Number Input', tone: 'green' },
  dropdown: { label: 'Dropdown', tone: 'orange' },
  toggle: { label: 'Toggle', tone: 'yellow' },
} as const

export const CalculatorFieldRowLabel = () => {
  const { data, rowNumber } = useRowLabel<Row>()

  const badge = BADGES[data?.type ?? 'number'] ?? BADGES.number
  const name =
    data?.label?.trim() ||
    data?.fieldKey?.trim() ||
    `Field ${String((rowNumber ?? 0) + 1).padStart(2, '0')}`

  return (
    <span className="cfrow">
      <span className="cfrow__name">{name}</span>
      <span className={`cfrow__badge cfrow__badge--${badge.tone}`}>{badge.label}</span>
    </span>
  )
}
