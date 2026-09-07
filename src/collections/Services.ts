import type { CollectionConfig } from 'payload'

import { requireTotpVerified } from '@/access/requireTotpVerified'
import { readPublishedOrVerified } from '@/access/publicRead'
import {
  revalidateContentAfterChange,
  revalidateContentAfterDelete,
} from '@/lib/revalidate'
import { translateCollectionAfterChange } from '@/lib/translation/hook'
import { slugField } from '@/lib/slug'

/**
 * Services — the core product offering (FUNCTIONALITY.md §3.3, §5.3;
 * TECHSPEC.md §5). Each service has public-facing content, a Home-page card,
 * and the data behind its price calculator.
 *
 * The editor is Payload's native document view, *shaped* to the prototype's
 * service editor (/prototype/admin/service-editor.html): four titled section
 * cards (Basic Information / Home Page Card / Calculator Fields / Price Formula
 * Builder), two-column field rows, the prototype's wording on every label, a
 * Published/Draft select beside the title, and calculator fields as blocks with
 * a type badge in their header. Everything below is ordinary Payload config —
 * `collapsible`/`row` are presentational only (they do NOT nest the data or
 * change the DB schema), the custom components are label/UI components, and the
 * skin lives in src/app/(payload)/custom.scss. Keeping the native view means
 * drafts, versions, localisation, access control and validation all still apply.
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
  // Publishing/editing/deleting a service invalidates the cached public pages
  // (Home cards + this service's page) — see src/lib/revalidate.ts.
  hooks: {
    // Auto-translate EN → FR/DE on save (Phase 5) BEFORE revalidation, so the
    // regenerated public pages read fresh translations. See src/lib/translation.
    afterChange: [translateCollectionAfterChange, revalidateContentAfterChange],
    afterDelete: [revalidateContentAfterDelete],
  },
  fields: [
    {
      type: 'collapsible',
      label: 'Basic Information',
      admin: {
        initCollapsed: false,
        className: 'asec asec--basic',
        components: {
          Label: '/components/admin/AdminSectionLabel#BasicInfoLabel',
        },
      },
      fields: [
        {
          type: 'row',
          fields: [
            {
              name: 'title',
              label: 'Service Title',
              type: 'text',
              required: true,
              localized: true,
              admin: { width: '50%' },
            },
            // Publish state. NOT a stored field — `_status` is a submit-time
            // override in Payload — so this is a `ui` field that performs
            // Payload's own Publish / Unpublish operations. See the component.
            {
              name: 'statusControl',
              type: 'ui',
              label: 'Status',
              admin: {
                width: '50%',
                components: {
                  Field: '/components/admin/PublishStatusField#PublishStatusField',
                },
              },
            },
          ],
        },
        // Clean, stable public URL: /services/<slug> (Phase 2b). Locale-independent,
        // auto-generated from the title, unique. See src/lib/slug.ts.
        slugField('title'),
        {
          name: 'description',
          label: 'Service Description (shown on the service page)',
          type: 'richText',
          localized: true,
        },
      ],
    },
    {
      type: 'collapsible',
      label: 'Home Page Card',
      admin: {
        initCollapsed: false,
        className: 'asec asec--card',
        components: {
          Label: '/components/admin/AdminSectionLabel#HomePageCardLabel',
        },
      },
      fields: [
        {
          type: 'group',
          name: 'card',
          // Label hidden here — the enclosing collapsible already titles this
          // section "Home Page Card"; the data still lives under `card.*`.
          label: false,
          admin: { className: 'fx-cardgroup' },
          fields: [
            {
              name: 'cardTitle',
              label: 'Card Title (shown in the home page tile)',
              type: 'text',
              localized: true,
              admin: {
                className: 'fx-cardtitle',
                description: 'Defaults to the service title if left blank.',
              },
            },
            {
              name: 'cardDescription',
              label: 'Card Short Description (1–3 sentences)',
              type: 'textarea',
              localized: true,
              admin: { className: 'fx-carddesc' },
            },
            {
              name: 'cardImage',
              label: 'Card Photo',
              type: 'upload',
              relationTo: 'media',
              admin: {
                className: 'fx-cardimage',
                description: 'PNG or JPG up to 5 MB · recommended 800×600.',
              },
            },
          ],
        },
        {
          name: 'heroImage',
          label: 'Hero Image (shown at top of service page)',
          type: 'upload',
          relationTo: 'media',
          admin: {
            className: 'fx-heroimage',
            description: 'PNG or JPG up to 5 MB · recommended 1600×600.',
          },
        },
      ],
    },
    {
      type: 'collapsible',
      label: 'Calculator Fields',
      admin: {
        initCollapsed: false,
        className: 'asec asec--calc',
        components: {
          Label: '/components/admin/AdminSectionLabel#CalculatorFieldsLabel',
        },
      },
      fields: [
        {
          name: 'calculatorFields',
          type: 'array',
          // The section header already reads "Calculator Fields".
          label: false,
          labels: { singular: 'Field', plural: 'Fields' },
          admin: {
            className: 'fx-calcfields',
            description:
              'The input fields shown in this service’s price calculator. Drag to ' +
              'reorder — visitors see them in this order. Leave empty for a service ' +
              'with no calculator.',
            components: {
              RowLabel:
                '/components/admin/CalculatorFieldRowLabel#CalculatorFieldRowLabel',
            },
          },
          // The array itself is NOT localized — the *set* of fields and their math
          // is identical across languages. Only the visitor-facing labels below
          // are localized (TECHSPEC §5: same fields everywhere, translated labels).
          fields: [
            {
              name: 'label',
              label: 'Field Label',
              type: 'text',
              required: true,
              localized: true,
              admin: { description: 'The field name the visitor sees.' },
            },
            {
              name: 'fieldKey',
              label: 'Field Key',
              type: 'text',
              required: true,
              admin: {
                description:
                  'Stable name the price formula refers to, e.g. "roof_area". ' +
                  'Lowercase, no spaces. Do not change it once a formula uses it.',
              },
            },
            {
              name: 'type',
              label: 'Field Type',
              type: 'select',
              required: true,
              defaultValue: 'number',
              options: [
                { label: 'Number Input', value: 'number' },
                { label: 'Dropdown', value: 'dropdown' },
                { label: 'Toggle (yes/no)', value: 'toggle' },
              ],
            },
            {
              name: 'unit',
              label: 'Unit (displayed next to the input)',
              type: 'text',
              localized: true,
              admin: {
                condition: (_data, siblingData) => siblingData?.type === 'number',
                description:
                  'Shown beside the visitor’s input, e.g. "m²", "kW", "hours". ' +
                  'Leave blank for a plain number.',
              },
            },
            {
              name: 'sign',
              label: 'Effect on Price',
              type: 'select',
              defaultValue: 'add',
              options: [
                { label: 'Positive (adds to the price)', value: 'add' },
                { label: 'Negative (subtracts from the price)', value: 'subtract' },
              ],
            },
            {
              name: 'unitPrice',
              label: 'Price per Unit (€)',
              type: 'number',
              admin: {
                description:
                  'What one unit of this field costs. For a yes/no toggle this is ' +
                  'the amount added when it is switched on.',
              },
            },
            {
              name: 'defaultOn',
              label: 'Default State: on',
              type: 'checkbox',
              defaultValue: false,
              admin: {
                condition: (_data, siblingData) => siblingData?.type === 'toggle',
                description:
                  'Tick to have this toggle already switched on when a visitor ' +
                  'opens the calculator.',
              },
            },
            {
              name: 'required',
              label: 'Required?',
              type: 'checkbox',
              defaultValue: false,
              admin: {
                description:
                  'The estimate is withheld until every required field is filled in.',
              },
            },
            {
              name: 'options',
              label: 'Dropdown Options (label : price multiplier)',
              type: 'array',
              labels: { singular: 'Option', plural: 'Options' },
              admin: {
                className: 'fx-options',
                condition: (_data, siblingData) => siblingData?.type === 'dropdown',
              },
              fields: [
                {
                  type: 'row',
                  fields: [
                    {
                      name: 'optionLabel',
                      label: 'Option',
                      type: 'text',
                      required: true,
                      localized: true,
                      admin: { width: '70%' },
                    },
                    {
                      name: 'value',
                      label: 'Value / multiplier',
                      type: 'number',
                      required: true,
                      admin: { width: '30%' },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      type: 'collapsible',
      label: 'Price Formula Builder',
      admin: {
        initCollapsed: false,
        className: 'asec asec--formula',
        components: {
          Label: '/components/admin/AdminSectionLabel#PriceFormulaLabel',
        },
      },
      fields: [
        {
          name: 'formula',
          type: 'json',
          admin: {
            description:
              'How this service’s price is calculated from its calculator fields. ' +
              'Built visually below; stored as a JSONLogic structure (never ' +
              'executable code). Leave empty to simply add up each field’s own ' +
              'unit price.',
            // The visual Formula Builder + live preview replaces raw JSON editing
            // of this field (TECHSPEC §6.4). It compiles to the same JSONLogic the
            // public calculator + shared evaluator already run, and falls back to a
            // raw-JSON editor for any non-builder formula.
            components: {
              Field: '/components/admin/FormulaBuilder#FormulaBuilder',
            },
          },
        },
        {
          name: 'disclaimer',
          label: 'Estimate Disclaimer',
          type: 'richText',
          localized: true,
          admin: {
            description:
              'Estimate-only wording shown around the calculator on the service ' +
              'page. Optional.',
          },
        },
      ],
    },
  ],
}
