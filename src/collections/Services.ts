import type { CollectionConfig } from 'payload'

import { requireTotpVerified } from '@/access/requireTotpVerified'
import { readPublishedOrVerified } from '@/access/publicRead'

/**
 * Services — the core product offering (FUNCTIONALITY.md §3.3, §5.3;
 * TECHSPEC.md §5). Each service has public-facing content, a Home-page card,
 * and the data behind its price calculator.
 *
 * Phase 1 scope: this defines the *data model* only. `calculatorFields` and
 * `formula` are stored here now (so no schema migration is needed later), but
 * the visual Calculator Field Builder / Formula Builder admin component and the
 * live-preview evaluator are Phase 3 (TECHSPEC §6.4). Until then these are
 * editable as plain fields / raw JSON by the admin.
 *
 * A service may be published with no calculator fields at all — the §7 edge
 * case where the service page shows description + contact details but no
 * calculator. Hence `calculatorFields`/`formula` are optional.
 */
export const Services: CollectionConfig = {
  slug: 'services',
  admin: {
    useAsTitle: 'title',
    defaultColumns: ['title', '_status', 'updatedAt'],
    group: 'Content',
    description:
      'Company services. Drag to reorder — this sets the order of the cards ' +
      'on the Home page.',
  },
  // Native drag-and-drop ordering (fractional indexing). This order is what the
  // Home page uses for its service cards (FUNCTIONALITY.md §3.1 / §5.3).
  orderable: true,
  access: {
    read: readPublishedOrVerified,
    create: requireTotpVerified(() => true),
    update: requireTotpVerified(() => true),
    delete: requireTotpVerified(() => true),
  },
  versions: {
    drafts: true,
  },
  fields: [
    {
      name: 'title',
      type: 'text',
      required: true,
      localized: true,
    },
    {
      name: 'description',
      type: 'richText',
      localized: true,
      admin: { description: 'Detailed description shown on the service page.' },
    },
    {
      name: 'heroImage',
      type: 'upload',
      relationTo: 'media',
      admin: { description: 'Service-page hero image.' },
    },
    {
      type: 'group',
      name: 'card',
      label: 'Home Page Card',
      admin: {
        description:
          'How this service appears in the grid on the Home page. The card ' +
          'image and title can differ from the hero image and service title.',
      },
      fields: [
        {
          name: 'cardTitle',
          type: 'text',
          localized: true,
          admin: {
            description: 'Defaults to the service title if left blank.',
          },
        },
        {
          name: 'cardDescription',
          type: 'textarea',
          localized: true,
          admin: { description: 'Short blurb (1–3 sentences) for the card.' },
        },
        {
          name: 'cardImage',
          type: 'upload',
          relationTo: 'media',
        },
      ],
    },
    {
      name: 'calculatorFields',
      type: 'array',
      label: 'Calculator Fields',
      admin: {
        description:
          'Input fields shown in this service’s price calculator. A visual ' +
          'builder replaces raw editing of these in Phase 3 (TECHSPEC §6.4). ' +
          'Leave empty for a service with no calculator.',
      },
      // The array itself is NOT localized — the *set* of fields and their math
      // is identical across languages. Only the visitor-facing labels below
      // are localized (TECHSPEC §5: same fields everywhere, translated labels).
      fields: [
        {
          name: 'fieldKey',
          type: 'text',
          required: true,
          admin: {
            description:
              'Stable identifier the pricing formula references, e.g. ' +
              '"roof_area". Lowercase, no spaces. Do not change once a formula ' +
              'uses it.',
          },
        },
        {
          name: 'label',
          type: 'text',
          required: true,
          localized: true,
          admin: { description: 'The field name the visitor sees.' },
        },
        {
          name: 'type',
          type: 'select',
          required: true,
          defaultValue: 'number',
          options: [
            { label: 'Number', value: 'number' },
            { label: 'Dropdown', value: 'dropdown' },
            { label: 'Toggle (yes/no)', value: 'toggle' },
          ],
        },
        {
          name: 'options',
          type: 'array',
          label: 'Dropdown Options',
          admin: {
            description: 'Selectable options and their values.',
            condition: (_data, siblingData) =>
              siblingData?.type === 'dropdown',
          },
          fields: [
            {
              name: 'optionLabel',
              type: 'text',
              required: true,
              localized: true,
            },
            {
              name: 'value',
              type: 'number',
              required: true,
            },
          ],
        },
        {
          name: 'unitPrice',
          type: 'number',
          admin: {
            description:
              'Amount the field’s value is multiplied by to get its ' +
              'contribution to the price.',
          },
        },
        {
          name: 'sign',
          type: 'select',
          defaultValue: 'add',
          options: [
            { label: 'Adds to the price (+)', value: 'add' },
            { label: 'Subtracts from the price (−)', value: 'subtract' },
          ],
        },
        {
          name: 'required',
          type: 'checkbox',
          defaultValue: false,
        },
      ],
    },
    {
      name: 'formula',
      type: 'json',
      admin: {
        description:
          'Pricing formula as a JSONLogic structure. Authored via the visual ' +
          'Formula Builder in Phase 3 (TECHSPEC §6.4); never executable code.',
      },
    },
    {
      name: 'disclaimer',
      type: 'richText',
      localized: true,
      admin: {
        description:
          'Estimate-only disclaimer shown around the calculator. Optional — ' +
          'a site-wide default can be applied at render time in Phase 2.',
      },
    },
  ],
}
