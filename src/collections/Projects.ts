import type { CollectionBeforeChangeHook, CollectionConfig } from 'payload'

import { requireTotpVerified } from '@/access/requireTotpVerified'
import { readPublishedOrVerified } from '@/access/publicRead'
import {
  revalidateContentAfterChange,
  revalidateContentAfterDelete,
} from '@/lib/revalidate'
import { translateCollectionAfterChange } from '@/lib/translation/hook'

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
    // The prototype's columns: Project | Category | Completion Date | Status |
    // Actions (/prototype/admin/projects.html). `serviceName` is the category
    // snapshot; `statusBadge` and `rowActions` are list-only `ui` fields below.
    defaultColumns: ['title', 'serviceName', 'completionDate', 'statusBadge', 'rowActions'],
    group: 'Content',
    components: {
      beforeListTable: ['/components/admin/ListCardHeader#ListCardHeader'],
    },
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
    // Auto-translate EN → FR/DE on save (Phase 5) before revalidation.
    afterChange: [translateCollectionAfterChange, revalidateContentAfterChange],
    afterDelete: [revalidateContentAfterDelete],
  },
  // Shaped to the prototype's project editor (/prototype/admin/projects.html):
  // one titled section card, title + completion date on one row, category +
  // status on the next, then the description and the photo drop zone. The
  // `collapsible`/`row` wrappers are presentational only — no data nesting, no
  // schema change — exactly as in src/collections/Services.ts.
  fields: [
    {
      type: 'collapsible',
      label: 'Project Details',
      admin: {
        initCollapsed: false,
        className: 'asec asec--project',
        components: {
          Label: '/components/admin/AdminSectionLabel#ProjectDetailsLabel',
        },
      },
      fields: [
        {
          type: 'row',
          fields: [
            {
              name: 'title',
              label: 'Project Title',
              type: 'text',
              required: true,
              localized: true,
              admin: { width: '50%' },
            },
            {
              name: 'completionDate',
              label: 'Completion Date',
              type: 'date',
              required: true,
              admin: {
                width: '50%',
                date: { pickerAppearance: 'dayOnly', displayFormat: 'dd/MM/yyyy' },
              },
            },
          ],
        },
        {
          type: 'row',
          fields: [
            {
              // Service-category link, used for the filter on the public Projects
              // page. The label is snapshotted onto `serviceName` (below) by a
              // beforeChange hook, so it survives the service being deleted
              // (FUNCTIONALITY.md §7).
              name: 'service',
              label: 'Service Category',
              type: 'relationship',
              relationTo: 'services',
              admin: {
                width: '50%',
                description:
                  'Used by the category filter on the public Projects page.',
              },
            },
            // Publish state — Payload's own Publish / Unpublish operations behind
            // the prototype's select. See the component.
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
        {
          name: 'description',
          label: 'Description',
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
    // ── List-only columns ────────────────────────────────────────────────
    // `ui` fields store nothing and render nothing in the editor (Payload's UI
    // field returns null without a `Field` component); they exist purely to give
    // the list table the prototype's status pill and Actions column.
    {
      name: 'statusBadge',
      label: 'Status',
      type: 'ui',
      admin: {
        components: { Cell: '/components/admin/StatusBadgeCell#StatusBadgeCell' },
      },
    },
    {
      name: 'rowActions',
      label: 'Actions',
      type: 'ui',
      admin: {
        components: { Cell: '/components/admin/RowActionsCell#RowActionsCell' },
      },
    },
    {
      // Denormalized snapshot of the linked service's label (FUNCTIONALITY.md §7).
      // Auto-maintained by `syncServiceNameSnapshot`; read-only in the admin.
      // Retained verbatim if the service is later deleted, so historical
      // portfolio entries never lose their category label.
      name: 'serviceName',
      // "Category" is what the prototype's list column calls it.
      label: 'Category',
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
