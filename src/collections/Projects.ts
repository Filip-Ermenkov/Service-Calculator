import type { CollectionBeforeChangeHook, CollectionConfig } from 'payload'

import { requireTotpVerified } from '@/access/requireTotpVerified'
import { readPublishedOrVerified } from '@/access/publicRead'
import {
  revalidateContentAfterChange,
  revalidateContentAfterDelete,
} from '@/lib/revalidate'

/**
 * Keep the denormalized `serviceName` snapshot in sync with the linked service's
 * (default-locale) title on every save — FUNCTIONALITY.md §7: a project must
 * retain its service-category LABEL even if the service is later deleted, so the
 * label is copied onto the project itself rather than only followed through the
 * relationship (which resolves to nothing once the service is gone).
 *
 * Runs before validation of the change, reading the relationship from the
 * incoming data (falling back to the existing value on partial updates). The
 * lookup shares the request transaction (`req`) and is best-effort: if the
 * service can't be read (e.g. it's mid-delete), any existing snapshot is kept.
 *
 * The snapshot is intentionally single-value (EN/default locale). Per-locale
 * category labels fall back to EN everywhere until the Phase 5 translation
 * pipeline, so a single canonical label is coherent and far simpler than a
 * localized snapshot synced across three locales.
 */
export const syncServiceNameSnapshot: CollectionBeforeChangeHook = async ({
  data,
  originalDoc,
  req,
}) => {
  const ref = data?.service !== undefined ? data.service : originalDoc?.service

  // Relationship explicitly cleared → drop the snapshot too.
  if (ref === null || ref === undefined) {
    return { ...data, serviceName: null }
  }

  const serviceId = typeof ref === 'object' ? (ref as { id: number }).id : ref
  try {
    const service = await req.payload.findByID({
      collection: 'services',
      id: serviceId,
      depth: 0,
      locale: 'en', // snapshot the canonical, default-locale label
      overrideAccess: true,
      req, // share the open transaction
      disableErrors: true,
    })
    if (service?.title) {
      return { ...data, serviceName: service.title }
    }
  } catch {
    // Service unreadable (deleted / permission) — preserve any existing snapshot.
  }
  return data
}

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
    beforeChange: [syncServiceNameSnapshot],
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
      // Service-category link, used for the filter on the public Projects page.
      // The label is snapshotted onto `serviceName` (below) by a beforeChange
      // hook, so it survives the service being deleted (FUNCTIONALITY.md §7).
      name: 'service',
      type: 'relationship',
      relationTo: 'services',
      admin: {
        description: 'Service category this project belongs to (for filtering).',
      },
    },
    {
      // Denormalized snapshot of the linked service's label (FUNCTIONALITY.md §7).
      // Auto-maintained by `syncServiceNameSnapshot`; read-only in the admin.
      // Retained verbatim if the service is later deleted, so historical
      // portfolio entries never lose their category label.
      name: 'serviceName',
      type: 'text',
      admin: {
        position: 'sidebar',
        readOnly: true,
        description:
          'Auto-filled from the linked service. Kept even if that service is ' +
          'later deleted, so this project keeps its category label.',
      },
    },
  ],
}
