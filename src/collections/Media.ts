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
  upload: true,
}
