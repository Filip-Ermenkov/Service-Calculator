'use client'

/**
 * The prototype's status pill in a list table (`.badge` in
 * /prototype/assets/css/style.css): green for live, yellow for draft, grey for
 * archived. Payload renders a status column as plain text; this is the same
 * value, drawn the way the prototype draws it.
 *
 * One component covers both status models in this project — Payload's
 * draft/publish `_status` (services, projects) and the careers collection's own
 * active/archived `status` — because it reads whichever the row carries.
 */

const BADGES: Record<string, { label: string; tone: string }> = {
  published: { label: 'Published', tone: 'green' },
  draft: { label: 'Draft', tone: 'yellow' },
  active: { label: 'Active', tone: 'green' },
  archived: { label: 'Archived', tone: 'gray' },
}

export const StatusBadgeCell = ({
  cellData,
  rowData,
}: {
  cellData?: unknown
  rowData?: { _status?: string; status?: string }
}) => {
  const raw =
    (typeof cellData === 'string' && cellData) || rowData?._status || rowData?.status || ''
  const badge = BADGES[raw]

  if (!badge) return <span className="abadge abadge--gray">—</span>

  return <span className={`abadge abadge--${badge.tone}`}>{badge.label}</span>
}
