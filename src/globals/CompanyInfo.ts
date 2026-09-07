import type { GlobalConfig } from 'payload'

import { requireTotpVerified } from '@/access/requireTotpVerified'
import { revalidateGlobalAfterChange } from '@/lib/revalidate'
import { translateGlobalAfterChange } from '@/lib/translation/hook'

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
  label: 'About & Company Info',
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
    // Auto-translate aboutUsContent EN → FR/DE on save (Phase 5).
    afterChange: [translateGlobalAfterChange, revalidateGlobalAfterChange],
  },
  // Shaped to the prototype's "About & Company Info" screen
  // (/prototype/admin/about.html): the About Us copy in its own titled section,
  // then the contact details as two two-column rows behind a highlighted note
  // that these values are used site-wide. Presentational wrappers only.
  //
  // The prototype's third section, "PDF Quote Branding" (a logo upload for the
  // PDF header), is deliberately absent: the quote PDF renders the wordmark as
  // styled text, matching the site itself (see src/lib/pdf/template.ts), so an
  // upload field here would collect a file nothing ever reads.
  fields: [
    {
      type: 'collapsible',
      label: 'About Us Page — Main Content',
      admin: {
        initCollapsed: false,
        className: 'asec asec--about',
        components: {
          Label: '/components/admin/AdminSectionLabel#AboutContentLabel',
        },
      },
      fields: [
        {
          // Localized: authored in EN, translated to FR/DE by the Phase 5 pipeline.
          name: 'aboutUsContent',
          label: 'Our Story',
          type: 'richText',
          localized: true,
          admin: {
            description:
              'Shown in the "Our Story" section of the About Us page. Write in ' +
              'English — the French and German versions are generated automatically.',
          },
        },
      ],
    },
    {
      type: 'collapsible',
      label: 'Company Contact Details',
      admin: {
        initCollapsed: false,
        className: 'asec asec--contact',
        components: {
          Label: '/components/admin/AdminSectionLabel#ContactDetailsLabel',
        },
      },
      fields: [
        {
          name: 'contactNote',
          type: 'ui',
          admin: {
            components: {
              Field: '/components/admin/ContactDetailsNote#ContactDetailsNote',
            },
          },
        },
        {
          type: 'row',
          fields: [
            {
              name: 'phone',
              label: 'Phone Number',
              type: 'text',
              admin: {
                width: '50%',
                description: 'Click-to-call on mobile.',
              },
            },
            {
              name: 'email',
              label: 'Email Address',
              type: 'email',
              required: true,
              admin: {
                width: '50%',
                description: 'Contact-form destination and public contact address.',
              },
            },
          ],
        },
        {
          type: 'row',
          fields: [
            {
              name: 'facebookUrl',
              label: 'Facebook Profile URL',
              type: 'text',
              admin: { width: '50%' },
            },
            {
              name: 'instagramUrl',
              label: 'Instagram Profile URL',
              type: 'text',
              admin: { width: '50%' },
            },
          ],
        },
      ],
    },
  ],
}
