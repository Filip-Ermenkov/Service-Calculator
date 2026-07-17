/**
 * Flattens a Payload Lexical rich-text value to a trimmed plain-text excerpt —
 * used for card blurbs and meta descriptions where full formatted rich text
 * would be too much. Walks the node tree collecting `text` leaves; returns '' for
 * anything that isn't a Lexical value, so callers can use it unconditionally.
 */
export function lexicalToPlainText(data: unknown, maxLength = 160): string {
  if (!data || typeof data !== 'object' || !('root' in data)) return ''

  const parts: string[] = []
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const n = node as { text?: unknown; children?: unknown }
    if (typeof n.text === 'string') parts.push(n.text)
    if (Array.isArray(n.children)) n.children.forEach(walk)
  }
  walk((data as { root?: unknown }).root)

  const text = parts.join(' ').replace(/\s+/g, ' ').trim()
  if (maxLength && text.length > maxLength) {
    return `${text.slice(0, maxLength).trimEnd()}…`
  }
  return text
}
