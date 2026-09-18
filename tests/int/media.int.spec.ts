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
import { REST_GET } from '@payloadcms/next/routes'
import config from '@/payload.config'
import { MEDIA_MAX_FILE_BYTES } from '@/collections/Media'

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
        .delete({ collection: 'media', id, context: { disableRevalidate: true } })
        .catch(() => undefined)
    }
  })

  it('uploads the file to S3 when a Media doc is created', async () => {
    const doc = await payload.create({
      collection: 'media',
      data: { alt: 'Integration test pixel' },
      context: { disableRevalidate: true },
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
      context: { disableRevalidate: true },
      file: {
        data: onePixelPng,
        mimetype: 'image/png',
        name: 'media-int-test-delete.png',
        size: onePixelPng.length,
      },
    })
    const filename = doc.filename as string

    await expect(objectExists(filename)).resolves.toBe(true)

    await payload.delete({ collection: 'media', id: doc.id, context: { disableRevalidate: true } })

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
      context: { disableRevalidate: true },
      file: { data: onePixelPng, mimetype: 'image/png', name: 'media-int-order-a.png', size: onePixelPng.length },
    })
    createdMediaIds.push(older.id)
    const newer = await payload.create({
      collection: 'media',
      data: { alt: 'Order test — newer' },
      context: { disableRevalidate: true },
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

  it(`rejects a file over the ${MEDIA_MAX_FILE_BYTES / (1024 * 1024)} MB cap before it reaches S3`, async () => {
    // Media bytes are served through the BUFFERED Web Lambda, whose 6 MB
    // response cap (after base64) turns a large photo into a 502 for visitors —
    // so the cap is a correctness limit, enforced by Media's beforeValidate hook
    // on every upload path (src/collections/Media.ts). The Local API is the one
    // path busboy's `upload.limits` and the presigned-URL check don't cover, so
    // this is the hook's own proof. A real PNG header keeps Payload's type sniff
    // and dimension read happy; the padding is what makes it oversized.
    const oversized = Buffer.concat([onePixelPng, Buffer.alloc(MEDIA_MAX_FILE_BYTES + 1 - onePixelPng.length)])
    expect(oversized.length).toBe(MEDIA_MAX_FILE_BYTES + 1)
    // Unique per run: a local re-run after a failed attempt must not be fooled
    // by a leftover object of the same name in S3Mock.
    const oversizedName = `media-int-test-oversized-${Date.now()}.png`
    await expect(
      payload.create({
        collection: 'media',
        data: { alt: 'Should be rejected (too large)' },
        context: { disableRevalidate: true },
        file: { data: oversized, mimetype: 'image/png', name: oversizedName, size: oversized.length },
      }),
    ).rejects.toMatchObject({
      name: 'ValidationError',
      data: { errors: [{ path: 'file', message: expect.stringMatching(/limit is 4 MB/) }] },
    })
    await expect(objectExists(oversizedName)).resolves.toBe(false)

    // Exactly at the cap is still allowed (the bound is inclusive).
    const atCap = Buffer.concat([onePixelPng, Buffer.alloc(MEDIA_MAX_FILE_BYTES - onePixelPng.length)])
    const ok = await payload.create({
      collection: 'media',
      data: { alt: 'At the cap' },
      context: { disableRevalidate: true },
      file: { data: atCap, mimetype: 'image/png', name: 'media-int-test-atcap.png', size: atCap.length },
    })
    createdMediaIds.push(ok.id)
    expect(ok.filesize).toBe(MEDIA_MAX_FILE_BYTES)
  })

  it('serves files with a CDN/browser Cache-Control and streams the real S3 bytes', async () => {
    // Drives the REAL file route (`GET /api/media/file/<name>`, the same
    // REST_GET handler Next mounts) so the `modifyResponseHeaders` contract is
    // proven on the response CloudFront actually sees — not on config alone.
    const doc = await payload.create({
      collection: 'media',
      data: { alt: 'Cache header case' },
      context: { disableRevalidate: true },
      file: { data: onePixelPng, mimetype: 'image/png', name: 'media-int-test-cache.png', size: onePixelPng.length },
    })
    createdMediaIds.push(doc.id)

    const handler = REST_GET(await config)
    const filename = doc.filename as string
    const res = await handler(
      new Request(`http://localhost:3000/api/media/file/${encodeURIComponent(filename)}`),
      { params: Promise.resolve({ slug: ['media', 'file', filename] }) },
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600, s-maxage=86400')
    const body = Buffer.from(await res.arrayBuffer())
    expect(body.equals(onePixelPng)).toBe(true)
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
        context: { disableRevalidate: true },
        file: { data: svg, mimetype: 'image/svg+xml', name: 'media-int-test-reject.svg', size: svg.length },
      }),
    ).rejects.toThrow()
    await expect(objectExists('media-int-test-reject.svg')).resolves.toBe(false)
  })
})
