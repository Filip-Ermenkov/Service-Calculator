import type { CollectionBeforeValidateHook, CollectionConfig } from 'payload'
import { ValidationError } from 'payload'

import { requireTotpVerified } from '@/access/requireTotpVerified'
import { orderNewDocumentsFirst } from '@/lib/orderable'
import { revalidateContentAfterChange, revalidateContentAfterDelete } from '@/lib/revalidate'

/**
 * Only raster web images. Every upload here is a photo for a card, hero,
 * project or job listing (the admin copy says "PNG or JPG"), so nothing
 * legitimate is lost — and it closes the classic stored-XSS vector: an SVG
 * (which can carry <script>) or an HTML/PDF file uploaded by a compromised
 * admin session would otherwise be served back from the same origin at
 * /media/<name>. Enforced by Payload on the multipart path
 * (`upload.mimeTypes` → checkFileRestrictions) AND by `enforceMediaFileLimits`
 * below, which also covers the direct-to-S3 client-upload path where Payload
 * never sees the bytes.
 */
export const MEDIA_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const

/**
 * Hard cap on one media file: 4 MB.
 *
 * WHY 4 MB. Until 2026-09-18 this was a CORRECTNESS limit: media bytes were
 * proxied through the Next/Payload Web function, which OpenNext builds BUFFERED
 * (6 MB response cap after base64), so a photo over ~4.5 MB uploaded "fine" and
 * then 502'd for every visitor. Media is now served by CloudFront straight from
 * the S3 bucket (src/lib/media/publicUrl.ts, sst.config.ts), so that ceiling is
 * gone. The cap stays as a PAGE-WEIGHT guard: nothing resizes an upload yet
 * (no `sharp`, no `next/image` — the next slice), so whatever the admin uploads
 * is exactly what every visitor downloads, and 4 MB is already >10× what a
 * 1600 px hero JPEG needs (~300 KB). Revisit the number together with
 * `next/image`, which makes large originals acceptable by serving resized
 * variants.
 *
 * Enforced in THREE places, one number:
 *   1. `upload.limits.fileSize` in src/payload.config.ts — busboy rejects an
 *      oversized multipart upload with 413 (the S3Mock/local path), and the
 *      storage-s3 plugin re-checks the same value when it mints a presigned
 *      PUT URL for the browser (the deployed path), signing `content-length`
 *      so S3 itself refuses a larger body (verified in
 *      @payloadcms/storage-s3 dist/generateSignedURL.js).
 *   2. `enforceMediaFileLimits` below — the document's own `filesize`, which
 *      the client-upload path supplies and the multipart/Local-API paths derive
 *      from the bytes. Catches a crafted create request and the Local API.
 *   3. The admin field descriptions ("up to 4 MB") in Services/Projects/Careers.
 */
export const MEDIA_MAX_FILE_BYTES = 4 * 1024 * 1024

/** Human form for error messages / admin copy ("4 MB"). */
export const MEDIA_MAX_FILE_LABEL = `${MEDIA_MAX_FILE_BYTES / (1024 * 1024)} MB`

/**
 * Refuse a Media document whose file is too large or not a raster image —
 * whichever path delivered it. Runs on create and on any update that carries
 * a (new) file; an update that only edits `alt` has no `filesize`/`mimeType`
 * in `data` and passes through untouched.
 */
export const enforceMediaFileLimits: CollectionBeforeValidateHook = ({ data, operation }) => {
  const filesize = (data as { filesize?: unknown } | undefined)?.filesize
  const mimeType = (data as { mimeType?: unknown } | undefined)?.mimeType

  const errors: { message: string; path: string }[] = []

  if (typeof filesize === 'number') {
    if (!Number.isFinite(filesize) || filesize < 0) {
      errors.push({ message: 'The file size could not be determined.', path: 'file' })
    } else if (filesize > MEDIA_MAX_FILE_BYTES) {
      errors.push({
        message: `This file is ${(filesize / (1024 * 1024)).toFixed(1)} MB — the limit is ${MEDIA_MAX_FILE_LABEL}. Please resize or compress the image and upload it again.`,
        path: 'file',
      })
    }
  } else if (operation === 'create') {
    // A new media document always has a file (filesRequiredOnCreate), and every
    // upload path records its size — a create without one is malformed.
    errors.push({ message: 'The file size could not be determined.', path: 'file' })
  }

  if (typeof mimeType === 'string' && !(MEDIA_MIME_TYPES as readonly string[]).includes(mimeType)) {
    errors.push({
      message: `Only JPEG, PNG or WebP images can be uploaded (got ${mimeType}).`,
      path: 'file',
    })
  }

  if (errors.length > 0) {
    throw new ValidationError({ collection: 'media', errors })
  }
  return data
}

export const Media: CollectionConfig = {
  slug: 'media',
  admin: {
    // Same card header as every other list ("All Media (n)"). Columns are
    // Payload's upload defaults (thumbnail + file name, alt, updated, created).
    components: {
      beforeListTable: ['/components/admin/ListCardHeader#ListCardHeader'],
    },
    description: `JPEG, PNG or WebP, up to ${MEDIA_MAX_FILE_LABEL} each.`,
  },
  // Drag ordering + bulk selection like every other list (added 2026-09-14,
  // migration `20260914_*_projects_media_orderable`). Nothing public reads the
  // media order — it exists so the admin can arrange the library — so the only
  // thing that matters is that it never makes the library WORSE to browse:
  // `orderNewDocumentsFirst` inserts each new upload at the top and the
  // migration backfilled existing files newest-first, so the default view still
  // reads "newest first" exactly as it did before the order key existed.
  orderable: true,
  hooks: {
    beforeValidate: [enforceMediaFileLimits],
    beforeChange: [orderNewDocumentsFirst],
    // A replaced or deleted file must reach the edge: `/media/*` is cached by
    // CloudFront for a day (the CachingOptimized policy on the media behaviour
    // in sst.config.ts), and a content page that embeds the image is not
    // re-rendered by a media-only edit, so purge on any change exactly like the
    // content collections do. One `/*` invalidation per media save is well
    // inside CloudFront's 1,000 free paths/month.
    afterChange: [revalidateContentAfterChange],
    afterDelete: [revalidateContentAfterDelete],
  },
  access: {
    // Public read is unrelated to admin auth (the public site fetches
    // media directly) and stays untouched. Writes go through the admin
    // panel only, so they get the same 2FA gate as every other admin
    // operation — see src/access/requireTotpVerified.ts.
    read: () => true,
    create: requireTotpVerified(() => true),
    update: requireTotpVerified(() => true),
    delete: requireTotpVerified(() => true),
  },
  fields: [
    {
      name: 'alt',
      type: 'text',
      required: true,
    },
  ],
  upload: {
    mimeTypes: [...MEDIA_MIME_TYPES],
    // No `modifyResponseHeaders`: Payload's file route is disabled for this
    // collection (`disablePayloadAccessControl` in src/payload.config.ts) —
    // CloudFront serves `/media/*` from S3, and the browser `Cache-Control` and
    // the security headers on those responses come from the response-headers
    // policy in sst.config.ts (src/lib/security/cloudfrontResponseHeaders.ts).
  },
}
