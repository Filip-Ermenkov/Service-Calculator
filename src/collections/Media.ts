import type { CollectionConfig } from 'payload'

import { requireTotpVerified } from '@/access/requireTotpVerified'
import { orderNewDocumentsFirst } from '@/lib/orderable'

export const Media: CollectionConfig = {
  slug: 'media',
  admin: {
    // Same card header as every other list ("All Media (n)"). Columns are
    // Payload's upload defaults (thumbnail + file name, alt, updated, created).
    components: {
      beforeListTable: ['/components/admin/ListCardHeader#ListCardHeader'],
    },
  },
  // Drag ordering + bulk selection like every other list (added 2026-09-14,
  // migration `20260914_*_projects_media_orderable`). Nothing public reads the
  // media order — it exists so the admin can arrange the library — so the only
  // thing that matters is that it never makes the library WORSE to browse:
  // `orderNewDocumentsFirst` inserts each new upload at the top and the
  // migration backfilled existing files newest-first, so the default view still
  // reads "newest first" exactly as it did before the order key existed.
  orderable: true,
  hooks: {
    beforeChange: [orderNewDocumentsFirst],
  },
  access: {
    // Public read is unrelated to admin auth (the public site fetches
    // media directly) and stays untouched. Writes go through the admin
    // panel only, so they get the same 2FA gate as every other admin
    // operation — see src/access/requireTotpVerified.ts.
    read: () => true,
    create: requireTotpVerified(() => true),
    update: requireTotpVerified(() => true),
    delete: requireTotpVerified(() => true),
  },
  fields: [
    {
      name: 'alt',
      type: 'text',
      required: true,
    },
  ],
  upload: {
    // Only raster web images. Every upload here is a photo for a card, hero,
    // project or job listing (the admin copy says "PNG or JPG"), so nothing
    // legitimate is lost — and it closes the classic stored-XSS vector: an SVG
    // (which can carry <script>) or an HTML/PDF file uploaded by a compromised
    // admin session would otherwise be served back from the same origin via
    // /api/media/file/<name>. Validated server-side by Payload on create/update.
    mimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
  },
}
