'use client'

/**
 * The highlighted note above the contact fields on the "About & Company Info"
 * screen (/prototype/admin/about.html): an orange-barred panel warning that
 * these few values are read across the whole site, so an edit here is never
 * local. Presentational only — a `ui` field, nothing stored.
 */

export const ContactDetailsNote = () => (
  <div className="anote">
    These values are used across the entire website — in the header, the footer,
    the About Us page, the service-page disclaimers, and every PDF quote.
    Changing them here updates every location automatically.
  </div>
)
