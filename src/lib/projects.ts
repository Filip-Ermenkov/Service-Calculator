/**
 * Pure, framework-free helpers behind the public Projects page's client-side
 * search + filter (FUNCTIONALITY.md §3.2). Kept out of the React component so the
 * matching logic is unit-testable without a DOM or a database.
 *
 * The server pre-maps each Payload `Project` into a lightweight `ProjectCard`
 * (plain strings only) so the client bundle never ships Lexical rich-text or the
 * full CMS document — just what the cards and the filter need.
 */

export interface ProjectCard {
  id: number
  title: string
  /** Plain-text description excerpt (Lexical already flattened server-side). */
  blurb: string
  /** Locale-formatted completion date, e.g. "March 2026" (formatted server-side). */
  dateLabel: string
  imageUrl: string | null
  imageAlt: string
  /**
   * Service-category label. This is the live service title while the service
   * exists, or the retained `serviceName` snapshot after it's deleted
   * (FUNCTIONALITY.md §7). Empty string when a project has no category.
   */
  category: string
}

/**
 * Filter cards by a free-text query (title OR description, case-insensitive) and
 * an exact service-category match. Both are optional and combine with AND — an
 * empty query and empty category return everything. Order is preserved (the
 * server already sorts newest-first).
 */
export function filterProjects(
  items: ProjectCard[],
  query: string,
  category: string,
): ProjectCard[] {
  const q = query.trim().toLowerCase()
  return items.filter((p) => {
    const matchesQuery =
      q === '' ||
      p.title.toLowerCase().includes(q) ||
      p.blurb.toLowerCase().includes(q)
    const matchesCategory = category === '' || p.category === category
    return matchesQuery && matchesCategory
  })
}

/**
 * The distinct, non-empty categories present among the given cards, sorted
 * alphabetically. Because it's derived from the cards themselves, a deleted
 * service's category only remains a filter option while projects still carry its
 * (snapshotted) label — exactly the §7 requirement.
 */
export function projectCategories(items: ProjectCard[]): string[] {
  const set = new Set<string>()
  for (const p of items) if (p.category) set.add(p.category)
  return Array.from(set).sort((a, b) => a.localeCompare(b))
}
