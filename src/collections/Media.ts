import type { CollectionConfig } from 'payload'

import { requireTotpVerified } from '@/access/requireTotpVerified'

export const Media: CollectionConfig = {
  slug: 'media',
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
