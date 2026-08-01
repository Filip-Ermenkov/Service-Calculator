/**
 * Lexical rich-text translation helpers (Phase 5).
 *
 * Payload stores rich text as a Lexical JSON tree, not HTML. To translate it we
 * walk the tree, collect every non-empty `text` leaf, and (after the provider
 * has translated those strings) rebuild an identical tree with each leaf swapped for
 * its translation. Structure, formatting marks, links, lists — everything except
 * the visible text — is preserved byte-for-byte, because we only ever touch the
 * `text` property of text nodes and clone everything else untouched.
 *
 * Translating leaf-by-leaf (rather than converting to HTML) is the robust choice
 * for a CMS: it can never corrupt the node structure, and for this site's prose
 * (paragraphs, headings, lists, links) it produces natural results. The one known
 * trade-off — a sentence split across formatting marks (e.g. a **bold** word
 * mid-sentence) is translated as separate fragments — is acceptable for marketing
 * copy and documented as a Phase 5 part-2 refinement (HTML tag-handling) if ever
 * needed.
 *
 * A Lexical text leaf is any object with a string `text` property. We are
 * deliberately permissive about the surrounding shape so this keeps working
 * across Lexical/Payload versions.
 */

/** True for a Payload/Lexical value that has a `root` node we can walk. */
export function isLexicalValue(value: unknown): value is { root: unknown } {
  return !!value && typeof value === 'object' && 'root' in (value as object)
}

/**
 * Collect every non-empty text-leaf string in the tree, in stable pre-order.
 * Adds them to `sink` (a Set for de-duplication, or any object with `.add`).
 */
export function collectLexicalStrings(value: unknown, sink: Set<string>): void {
  if (!isLexicalValue(value)) return
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const n = node as { text?: unknown; children?: unknown }
    if (typeof n.text === 'string' && n.text.trim().length > 0) {
      sink.add(n.text)
    }
    if (Array.isArray(n.children)) n.children.forEach(walk)
  }
  walk((value as { root?: unknown }).root)
}

/**
 * Return a deep clone of `value` with every text leaf replaced by
 * `map.get(leaf.text)` when present (falling back to the original text — so an
 * untranslated or whitespace-only leaf is left exactly as-is). The input is never
 * mutated.
 *
 * Returns the input unchanged (by reference) if it isn't a Lexical value, so
 * callers can apply it unconditionally.
 */
export function rebuildLexicalWithTranslations<T>(value: T, map: Map<string, string>): T {
  if (!isLexicalValue(value)) return value
  const clone = structuredClone(value) as { root?: unknown }
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const n = node as { text?: unknown; children?: unknown }
    if (typeof n.text === 'string' && n.text.trim().length > 0) {
      const replacement = map.get(n.text)
      if (typeof replacement === 'string') n.text = replacement
    }
    if (Array.isArray(n.children)) n.children.forEach(walk)
  }
  walk(clone.root)
  return clone as T
}
