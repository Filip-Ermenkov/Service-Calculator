/**
 * Renders a JSON-LD structured-data block (TECHSPEC §6.11). Server-rendered into
 * the page so crawlers see schema.org data (LocalBusiness on Home, Service on
 * each service page) without any client JS. Content is generated from data we
 * already hold (CompanyInfo / Services), so there is no extra authoring burden.
 */

/**
 * Serialise for an inline `<script type="application/ld+json">`.
 *
 * `JSON.stringify` escapes quotes and control characters but NOT `<`, and the
 * HTML parser ends a script element at the first `</script` it sees — inside a
 * string literal or not. So an admin-authored value such as a service title of
 * `Roofing</script><script>…` would break out of the JSON block and run. The
 * values here come from authenticated, 2FA-gated admins, so this is
 * defence-in-depth rather than a live hole, but it costs one `replace` and is
 * the pattern Next.js's own JSON-LD guidance uses. `<` is valid JSON and
 * decodes back to `<` for every consumer of the structured data.
 */
export function serializeJsonLd(data: Record<string, unknown>): string {
  return JSON.stringify(data).replace(/</g, '\\u003c')
}

export function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      // Safe to inline: see serializeJsonLd — `<` can never appear in the output.
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }}
    />
  )
}
