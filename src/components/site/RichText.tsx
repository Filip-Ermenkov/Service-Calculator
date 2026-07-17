import { RichText as PayloadRichText } from '@payloadcms/richtext-lexical/react'
import type { SerializedEditorState } from '@payloadcms/richtext-lexical/lexical'

/**
 * Renders Payload Lexical rich-text content to React on the server, using
 * Payload's own built-in JSX converters (the current best practice — see
 * https://payloadcms.com/docs/rich-text/converting-jsx).
 *
 * The Payload-generated field type is a looser `{ root: … }` shape than
 * `SerializedEditorState`; the cast bridges the two. Content is admin-authored
 * prose (headings, lists, links, bold), so the default converters cover it; if
 * internal-document links are ever introduced, add a `LinkJSXConverter` here.
 */
type LexicalData = { root: unknown } | SerializedEditorState | null | undefined

export function RichText({
  data,
  className,
}: {
  data: LexicalData
  className?: string
}) {
  if (!data || typeof data !== 'object' || !('root' in data)) return null
  return (
    <div className={className}>
      <PayloadRichText data={data as SerializedEditorState} />
    </div>
  )
}
