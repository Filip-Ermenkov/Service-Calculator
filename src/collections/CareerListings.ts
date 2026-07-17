import type { CollectionConfig } from 'payload'

import { requireTotpVerified } from '@/access/requireTotpVerified'
import { publicReadWhen } from '@/access/publicRead'
import {
  revalidateContentAfterChange,
  revalidateContentAfterDelete,
} from '@/lib/revalidate'

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
    singular: 'Career Listing',
    plural: 'Career Listings',
  },
  admin: {
    useAsTitle: 'title',
    defaultColumns: ['title', 'status', 'updatedAt'],
    group: 'Content',
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
    afterChange: [revalidateContentAfterChange],
    afterDelete: [revalidateContentAfterDelete],
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
      admin: { description: 'Role summary, responsibilities, requirements.' },
    },
    {
      name: 'photo',
      type: 'upload',
      relationTo: 'media',
    },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'active',
      options: [
        { label: 'Active', value: 'active' },
        { label: 'Archived', value: 'archived' },
      ],
      admin: {
        description: 'Archived listings are hidden from the public site.',
        position: 'sidebar',
      },
    },
  ],
}
