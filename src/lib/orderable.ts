import type { CollectionBeforeChangeHook } from 'payload'
import { generateKeyBetween } from 'payload/shared'

/**
 * Put a NEWLY CREATED document at the TOP of a drag-orderable collection.
 *
 * Payload's `orderable: true` gives every document a fractional-index key
 * (`_order`) and, by its own `beforeChange` hook, appends a new document AFTER
 * the last one. That is right for Services and Careers (a new card/listing goes
 * at the end of the grid), but wrong for Projects and Media, whose lists — and,
 * for Projects, the public page — read "newest first": a freshly added project
 * appearing at the bottom until someone drags it up would silently change what
 * the site has always shown. This hook runs BEFORE Payload's (Payload pushes
 * its hook onto the array during sanitisation, i.e. after the ones declared in
 * the config), so on create it mints a key that sorts before the current first
 * document; Payload's hook then sees `_order` already set and leaves it alone.
 *
 * Only `create` is touched. Drag-reorders write `_order` explicitly, and any
 * other update keeps the existing key.
 */
export const orderNewDocumentsFirst: CollectionBeforeChangeHook = async ({
  collection,
  data,
  operation,
  originalDoc,
  req,
}) => {
  if (operation !== 'create') return data
  const incoming = (data as { _order?: unknown } | undefined)?._order
  const existing = (originalDoc as { _order?: unknown } | undefined)?._order
  if (incoming || existing) return data

  const first = await req.payload.find({
    collection: collection.slug as never,
    depth: 0,
    limit: 1,
    pagination: false,
    sort: '_order',
    where: { _order: { exists: true } },
    select: { _order: true } as never,
    overrideAccess: true,
    req,
  })
  const firstKey = (first.docs[0] as { _order?: string | null } | undefined)?._order ?? null

  return { ...data, _order: generateKeyBetween(null, firstKey) }
}
