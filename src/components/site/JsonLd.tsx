/**
 * Renders a JSON-LD structured-data block (TECHSPEC §6.11). Server-rendered into
 * the page so crawlers see schema.org data (LocalBusiness on Home, Service on
 * each service page) without any client JS. Content is generated from data we
 * already hold (CompanyInfo / Services), so there is no extra authoring burden.
 */
export function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      // Data is app-generated (not user free-text injected raw), and JSON.stringify
      // escapes it; safe to inline.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  )
}
