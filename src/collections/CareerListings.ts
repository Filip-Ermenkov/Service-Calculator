import type { CollectionConfig } from 'payload'

import { requireTotpVerified } from '@/access/requireTotpVerified'
import { publicReadWhen } from '@/access/publicRead'
import {
  revalidateContentAfterChange,
  revalidateContentAfterDelete,
} from '@/lib/revalidate'
import { translateCollectionAfterChange } from '@/lib/translation/hook'

/**
 * Career listings — open job positions (FUNCTIONALITY.md §3.5, §5.5).
 *
 * Uses an explicit `status` (active/archived) rather than draft/publish
 * versioning: §5.5 models this as an Active/Archived visibility toggle with
 * Archive/Restore, not a draft-then-publish authoring workflow, and job
 * listings don't need version history. Archived listings are hidden from
 * visitors; the admin (fully 2FA-verified) still sees them so they can be
 * restored.
 */
export const CareerListings: CollectionConfig = {
  slug: 'career-listings',
  labels: {
    singular: 'Job Opening',
    plural: 'Careers',
  },
  admin: {
    useAsTitle: 'title',
    // The prototype's columns: Position | Status | Actions
    // (/prototype/admin/careers.html). `rowActions` is a list-only `ui` field.
    defaultColumns: ['title', 'status', 'rowActions'],
    group: 'Content',
    components: {
      beforeListTable: ['/components/admin/ListCardHeader#ListCardHeader'],
    },
    description:
      'Open positions. Drag to reorder — this sets the display order on the ' +
      'public Careers page.',
  },
  // Admin arranges listing order by drag-and-drop (FUNCTIONALITY.md §5.5).
  orderable: true,
  access: {
    // Public sees only active listings; a fully-verified admin sees archived
    // ones too (to restore them).
    read: publicReadWhen({ status: { equals: 'active' } }),
    create: requireTotpVerified(() => true),
    update: requireTotpVerified(() => true),
    delete: requireTotpVerified(() => true),
  },
  hooks: {
    // Auto-translate EN → FR/DE on save (Phase 5) before revalidation.
    afterChange: [translateCollectionAfterChange, revalidateContentAfterChange],
    afterDelete: [revalidateContentAfterDelete],
  },
  // Shaped to the prototype's job editor (/prototype/admin/careers.html): one
  // titled section card with the job title and its Active/Archived status on a
  // single row, then the description and the photo drop zone. Presentational
  // wrappers only — no data nesting, no schema change.
  fields: [
    {
      type: 'collapsible',
      label: 'Job Opening',
      admin: {
        initCollapsed: false,
        className: 'asec asec--job',
        components: {
          Label: '/components/admin/AdminSectionLabel#JobOpeningLabel',
        },
      },
      fields: [
        {
          type: 'row',
          fields: [
            {
              name: 'title',
              label: 'Job Title',
              type: 'text',
              required: true,
              localized: true,
              admin: { width: '50%' },
            },
            {
              // NOT Payload's draft/publish state — §5.5 models careers as an
              // Active/Archived visibility toggle, so this is a real stored
              // field and sits inline exactly like the prototype's select.
              name: 'status',
              label: 'Status',
              type: 'select',
              required: true,
              defaultValue: 'active',
              options: [
                { label: 'Active', value: 'active' },
                { label: 'Archived', value: 'archived' },
              ],
              admin: {
                width: '50%',
                description: 'Archived listings are hidden from the public site.',
                // Drawn as the prototype's status pill in the list table.
                components: { Cell: '/components/admin/StatusBadgeCell#StatusBadgeCell' },
              },
            },
          ],
        },
        {
          name: 'description',
          label: 'Description (role, responsibilities, requirements)',
          type: 'richText',
          localized: true,
        },
        {
          name: 'photo',
          label: 'Photo',
          type: 'upload',
          relationTo: 'media',
          admin: { description: 'PNG or JPG up to 5 MB.' },
        },
      ],
    },
    // List-only column: the prototype's Edit / Archive-Restore / Delete actions.
    // Stores nothing and renders nothing in the editor.
    {
      name: 'rowActions',
      label: 'Actions',
      type: 'ui',
      admin: {
        components: { Cell: '/components/admin/RowActionsCell#RowActionsCell' },
      },
    },
  ],
}
