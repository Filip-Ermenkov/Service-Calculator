/**
 * "Last edited: yesterday" — the quiet sub-line under a record's title in every
 * admin list (TitleCell.tsx), copied from the prototype's Services table. Pure so
 * it can run in a client cell and be unit-tested without React.
 */
export function relativeEdited(iso: string | undefined | null, now: number = Date.now()): string {
  if (!iso) return 'Last edited: —'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return 'Last edited: —'
  const days = Math.floor((now - then) / 86_400_000)
  if (days <= 0) return 'Last edited: today'
  if (days === 1) return 'Last edited: yesterday'
  if (days < 7) return `Last edited: ${days} days ago`
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `Last edited: ${weeks} week${weeks > 1 ? 's' : ''} ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `Last edited: ${months} month${months > 1 ? 's' : ''} ago`
  const years = Math.floor(days / 365)
  return `Last edited: ${years} year${years > 1 ? 's' : ''} ago`
}
