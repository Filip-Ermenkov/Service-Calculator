import type { CollectionConfig } from 'payload'

import { requireTotpVerified } from '@/access/requireTotpVerified'
import { readPublishedOrVerified } from '@/access/publicRead'
import {
  revalidateContentAfterChange,
  revalidateContentAfterDelete,
} from '@/lib/revalidate'

/**
 * Projects — the company's portfolio (FUNCTIONALITY.md §3.2, §5.4).
 * Newest-completed first by default; filterable by service on the public page.
 */
export const Projects: CollectionConfig = {
  slug: 'projects',
  admin: {
    useAsTitle: 'title',
    defaultColumns: ['title', 'completionDate', 'service', '_status'],
    group: 'Content',
  },
  // Public Projects grid is "sorted by completion date, newest first, by
  // default" (FUNCTIONALITY.md §3.2).
  defaultSort: '-completionDate',
  access: {
    read: readPublishedOrVerified,
    create: requireTotpVerified(() => true),
    update: requireTotpVerified(() => true),
    delete: requireTotpVerified(() => true),
  },
  versions: {
    drafts: true,
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
    },
    {
      name: 'photo',
      type: 'upload',
      relationTo: 'media',
    },
    {
      name: 'completionDate',
      type: 'date',
      required: true,
      admin: {
        date: { pickerAppearance: 'dayOnly', displayFormat: 'dd/MM/yyyy' },
      },
    },
    {
      // Used for the service-category filter on the public Projects page.
      // NOTE (Phase 2): FUNCTIONALITY.md §7 requires a project to retain its
      // service-category *label* even if the service is later deleted. A plain
      // relationship loses the label on delete, so a denormalized snapshot of
      // the service name will be added when the Projects page filter is built
      // in Phase 2. Defined as a relationship here so the data model is correct
      // now; the retain-on-delete behavior is tracked as a Phase 2 item.
      name: 'service',
      type: 'relationship',
      relationTo: 'services',
      admin: {
        description: 'Service category this project belongs to (for filtering).',
      },
    },
  ],
}
