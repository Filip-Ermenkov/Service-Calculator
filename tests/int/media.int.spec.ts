/**
 * @vitest-environment node
 *
 * Runs in the `node` environment rather than the suite-default `jsdom`, for the
 * same reason as tests/int/rest.int.spec.ts. Since src/collections/Media.ts
 * restricts `upload.mimeTypes`, Payload sniffs every upload's real bytes with
 * `file-type` (checkFileRestrictions.js) — and under Vitest's jsdom setup the
 * global `Uint8Array` is jsdom's copy, so a Node `Buffer` fails file-type's
 * `instanceof` check and Payload rejects EVERY file with "Could not read uploaded
 * file for type detection", valid PNGs included. These are server-side Local-API
 * tests with no DOM; `node` is the correct environment.
 */
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getPayload, Payload } from 'payload'
import config from '@/payload.config'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Exercises the real S3 (S3Mock, in dev/CI) upload/delete round-trip through
// Payload's Local API. This is the one gap flagged at Phase 0 sign-off
// (docs/PROGRESS.md, docs/TECHSPEC.md §12): media upload/delete was only
// ever manually verified in a browser. It's testable via the Local API
// (rather than needing Playwright + a real browser PUT) because
// @payloadcms/storage-s3's handleUpload/handleDelete hooks call the real S3
// SDK server-side regardless of the clientUploads flag — see the comment in
// src/payload.config.ts. Verification goes around Payload (direct S3
// HeadObjectCommand calls) so the test can't pass on DB state alone while
// the actual object is missing.
//
// Requires either the S3Mock container from docker-compose.yml (or the
// equivalent CI service in .github/workflows/ci.yml) to be running and
// reachable at S3_ENDPOINT, or a real bucket reachable with your local AWS
// credentials (S3_BUCKET/AWS_REGION only, no S3_ENDPOINT) — see README.md
// "Testing" and .env.example.
//
// This client's config must stay in lockstep with the s3Storage() config in
// src/payload.config.ts: same conditional (only override
// endpoint/forcePathStyle/credentials when S3_ENDPOINT is set). Letting them
// diverge is exactly the bug that made this test fail against a real bucket
// while Payload's own upload succeeded — forcing path-style addressing and
// fake credentials onto a real-AWS client breaks it in a way the SDK can't
// turn into a readable error (surfaces as an opaque "UnknownError" instead
// of e.g. NoSuchBucket/InvalidAccessKeyId).
const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'eu-central-1',
  ...(process.env.S3_ENDPOINT && {
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID || 'test',
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || 'test',
    },
  }),
})

const bucket = process.env.S3_BUCKET || ''

async function objectExists(key: string): Promise<boolean> {
  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    return true
  } catch (err) {
    const name = (err as { name?: string })?.name
    if (name === 'NotFound' || name === 'NoSuchKey') return false
    throw err
  }
}

// A minimal valid 1x1 PNG — content doesn't matter (sharp/resizing is not
// configured on the Media collection), only that S3 receives real bytes.
const onePixelPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

let payload: Payload
const createdMediaIds: (number | string)[] = []

describe('Media upload/delete (real S3, via S3Mock)', () => {
  beforeAll(async () => {
    if (!bucket) {
      throw new Error(
        'S3_BUCKET is not set — required for the media upload/delete integration test. ' +
          'See README.md "Testing" / .env.example.',
      )
    }
    const payloadConfig = await config
    payload = await getPayload({ config: payloadConfig })
  })

  afterAll(async () => {
    // Best-effort cleanup in case an assertion failed before a test's own
    // delete step ran.
    for (const id of createdMediaIds) {
      await payload
        .delete({ collection: 'media', id })
        .catch(() => undefined)
    }
  })

  it('uploads the file to S3 when a Media doc is created', async () => {
    const doc = await payload.create({
      collection: 'media',
      data: { alt: 'Integration test pixel' },
      file: {
        data: onePixelPng,
        mimetype: 'image/png',
        name: 'media-int-test.png',
        size: onePixelPng.length,
      },
    })
    createdMediaIds.push(doc.id)

    expect(doc.filename).toBeTruthy()
    expect(doc.filesize).toBe(onePixelPng.length)
    expect(doc.mimeType).toBe('image/png')

    // The real assertion: the object actually exists in S3, not just in the
    // Postgres row.
    await expect(objectExists(doc.filename as string)).resolves.toBe(true)
  })

  it('deletes the file from S3 when the Media doc is deleted', async () => {
    const doc = await payload.create({
      collection: 'media',
      data: { alt: 'Integration test pixel (delete case)' },
      file: {
        data: onePixelPng,
        mimetype: 'image/png',
        name: 'media-int-test-delete.png',
        size: onePixelPng.length,
      },
    })
    const filename = doc.filename as string

    await expect(objectExists(filename)).resolves.toBe(true)

    await payload.delete({ collection: 'media', id: doc.id })

    // Not tracked for afterAll cleanup — it's already gone, and re-deleting
    // a Media doc whose S3 object no longer exists is exactly the failure
    // mode this test would catch.
    await expect(objectExists(filename)).resolves.toBe(false)
  })

  it('puts a newer upload BEFORE an older one in the drag order (library stays newest-first)', async () => {
    // Media is `orderable` since 2026-09-14; src/lib/orderable.ts inserts each
    // new upload at the top so the library's default `_order` view still reads
    // newest-first (Payload's own default would append it at the bottom).
    const older = await payload.create({
      collection: 'media',
      data: { alt: 'Order test — older' },
      file: { data: onePixelPng, mimetype: 'image/png', name: 'media-int-order-a.png', size: onePixelPng.length },
    })
    createdMediaIds.push(older.id)
    const newer = await payload.create({
      collection: 'media',
      data: { alt: 'Order test — newer' },
      file: { data: onePixelPng, mimetype: 'image/png', name: 'media-int-order-b.png', size: onePixelPng.length },
    })
    createdMediaIds.push(newer.id)

    const a = (older as { _order?: string | null })._order ?? ''
    const b = (newer as { _order?: string | null })._order ?? ''
    expect(a.length).toBeGreaterThan(0)
    expect(b < a).toBe(true)

    const listed = await payload.find({ collection: 'media', sort: '_order', depth: 0, limit: 100, overrideAccess: true })
    const pos = (id: number | string) => listed.docs.findIndex((d) => d.id === id)
    expect(pos(newer.id)).toBeLessThan(pos(older.id))
  })

  it('rejects a non-image upload (SVG can carry <script>; served same-origin it is stored XSS)', async () => {
    // src/collections/Media.ts restricts `upload.mimeTypes` to raster images.
    // Payload validates the mime type server-side on create, so the rejected
    // file must never reach S3 either.
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    await expect(
      payload.create({
        collection: 'media',
        data: { alt: 'Should be rejected' },
        file: { data: svg, mimetype: 'image/svg+xml', name: 'media-int-test-reject.svg', size: svg.length },
      }),
    ).rejects.toThrow()
    await expect(objectExists('media-int-test-reject.svg')).resolves.toBe(false)
  })
})
