import type { GlobalConfig } from 'payload'

import { requireTotpVerified } from '@/access/requireTotpVerified'
import { revalidateGlobalAfterChange } from '@/lib/revalidate'

/**
 * Single source of truth for the company's contact details and About Us copy.
 * Referenced everywhere contact info appears (header, footer, About page,
 * service-page disclaimer, PDF quotes) so one edit propagates site-wide —
 * FUNCTIONALITY.md §5.6.
 *
 * No draft workflow: §5.6 states changes are reflected immediately, so this
 * global is always "live". Writes still require the full 2FA step-up.
 */
export const CompanyInfo: GlobalConfig = {
  slug: 'company-info',
  label: 'Company Info',
  admin: {
    group: 'Settings',
    description:
      'Contact details and About Us content, used across the whole site. ' +
      'Changes here apply immediately everywhere they appear.',
  },
  access: {
    // Contact details are public (shown in header/footer/About). Writes are
    // 2FA-gated like every other admin mutation.
    read: () => true,
    update: requireTotpVerified(() => true),
  },
  // Contact details/About copy appear site-wide (header, footer, About, service
  // pages), so a change here revalidates the whole public site.
  hooks: {
    afterChange: [revalidateGlobalAfterChange],
  },
  fields: [
    {
      name: 'email',
      type: 'email',
      required: true,
      admin: {
        description: 'Contact-form destination and public contact address.',
      },
    },
    {
      name: 'phone',
      type: 'text',
      admin: { description: 'Public phone number (click-to-call on mobile).' },
    },
    {
      name: 'facebookUrl',
      type: 'text',
      label: 'Facebook URL',
    },
    {
      name: 'instagramUrl',
      type: 'text',
      label: 'Instagram URL',
    },
    {
      // Localized: authored in EN, translated to FR/DE in Phase 5.
      name: 'aboutUsContent',
      type: 'richText',
      localized: true,
      admin: { description: 'About Us page body (rich text).' },
    },
  ],
}
