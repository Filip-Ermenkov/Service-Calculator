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
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getPayload, Payload } from 'payload'
import { REST_GET } from '@payloadcms/next/routes'
import config from '@/payload.config'
import { MEDIA_MAX_FILE_BYTES } from '@/collections/Media'
import { MEDIA_PUBLIC_PATH, MEDIA_S3_PREFIX, mediaPublicUrl } from '@/lib/media/publicUrl'

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

/**
 * Every media object lives under the collection prefix (src/lib/media/publicUrl.ts):
 * the S3 key for `roof.jpg` is `media/roof.jpg`, and that key IS the public URL
 * path. Tests look objects up by their stored filename through this helper so the
 * prefix contract is asserted on every existence check, not just once.
 */
const keyFor = (filename: string) => `${MEDIA_S3_PREFIX}/${filename}`

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

    // The real assertion: the object actually exists in S3 — under the
    // collection prefix — not just in the Postgres row. A root-level object
    // would be unreachable at the edge (CloudFront's `/media/*` behaviour maps
    // the URL path 1:1 onto the key).
    await expect(objectExists(keyFor(doc.filename as string))).resolves.toBe(true)
    await expect(objectExists(doc.filename as string)).resolves.toBe(false)
  })

  it('stores the prefix and a public URL whose path equals the S3 key (the CDN contract)', async () => {
    // src/lib/media/publicUrl.ts is what CloudFront (sst.config.ts) and the local
    // S3Mock rewrite (next.config.ts) both rely on: `/media/<file>` must be
    // exactly `/` + the object key. The `url` Payload persists is produced by
    // the storage plugin's generateFileURL on create (beforeChange) and again
    // on every read (afterRead); both are covered — the create result and a
    // fresh access-controlled read.
    const doc = await payload.create({
      collection: 'media',
      data: { alt: 'URL contract case' },
      context: { disableRevalidate: true },
      file: { data: onePixelPng, mimetype: 'image/png', name: 'media int url contract.png', size: onePixelPng.length },
    })
    createdMediaIds.push(doc.id)
    const filename = doc.filename as string

    expect((doc as { prefix?: string | null }).prefix).toBe(MEDIA_S3_PREFIX)
    expect(doc.url).toBe(mediaPublicUrl({ filename, prefix: MEDIA_S3_PREFIX }))
    expect(doc.url).toBe(`${MEDIA_PUBLIC_PATH}/${encodeURIComponent(filename)}`)
    // Relative, so it is correct on bulbau.lu, the staging CloudFront host and
    // localhost alike; Next resolves it against metadataBase where an absolute
    // URL is needed (Open Graph).
    expect(doc.url!.startsWith('/')).toBe(true)
    // URL path === object key: decode the URL and the object must be there.
    const keyFromUrl = decodeURIComponent(doc.url!.slice(1))
    expect(keyFromUrl).toBe(keyFor(filename))
    await expect(objectExists(keyFromUrl)).resolves.toBe(true)

    // The bytes S3 holds under that key are the uploaded bytes, with the
    // Content-Type the edge will serve.
    const stored = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: keyFromUrl }))
    expect(stored.ContentType).toBe('image/png')
    expect(Buffer.from(await stored.Body!.transformToByteArray()).equals(onePixelPng)).toBe(true)

    // Public (access-controlled) read regenerates the same URL from the stored
    // prefix — what the site's data layer and the REST API hand to pages.
    const read = await payload.findByID({ collection: 'media', id: doc.id, overrideAccess: false })
    expect(read.url).toBe(doc.url)
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
    const key = keyFor(doc.filename as string)

    await expect(objectExists(key)).resolves.toBe(true)

    await payload.delete({ collection: 'media', id: doc.id, context: { disableRevalidate: true } })

    // Not tracked for afterAll cleanup — it's already gone, and re-deleting
    // a Media doc whose S3 object no longer exists is exactly the failure
    // mode this test would catch.
    await expect(objectExists(key)).resolves.toBe(false)
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
    // The cap is a page-weight guard now that media is served from S3 by
    // CloudFront (it used to be the buffered Web Lambda's 6 MB ceiling — see
    // src/collections/Media.ts), enforced by Media's beforeValidate hook on
    // every upload path. The Local API is the one path busboy's `upload.limits`
    // and the presigned-URL check don't cover, so this is the hook's own proof.
    // A real PNG header keeps Payload's type sniff and dimension read happy;
    // the padding is what makes it oversized.
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
    await expect(objectExists(keyFor(oversizedName))).resolves.toBe(false)

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

  it("Payload's own file route is switched off — media is not proxied through the app any more", async () => {
    // `disablePayloadAccessControl` (src/payload.config.ts) removes the
    // `/api/media/file/<name>` handler: that route streamed every byte through
    // the buffered Web Lambda (6 MB cap) and is exactly what the CloudFront
    // `/media/*` behaviour replaces. Drive the REAL REST handler so the proof is
    // on the mounted route, not on config. With no handler and no local
    // `staticDir`, Payload falls through to its disk lookup and answers the
    // uniform "Something went wrong." — never the bytes.
    const doc = await payload.create({
      collection: 'media',
      data: { alt: 'File route is off' },
      context: { disableRevalidate: true },
      file: { data: onePixelPng, mimetype: 'image/png', name: 'media-int-test-route-off.png', size: onePixelPng.length },
    })
    createdMediaIds.push(doc.id)

    const handler = REST_GET(await config)
    const filename = doc.filename as string
    const res = await handler(
      new Request(`http://localhost:3000/api/media/file/${encodeURIComponent(filename)}`),
      { params: Promise.resolve({ slug: ['media', 'file', filename] }) },
    )
    expect(res.status).not.toBe(200)
    expect(res.headers.get('content-type') ?? '').not.toContain('image/png')
    const body = Buffer.from(await res.arrayBuffer())
    expect(body.equals(onePixelPng)).toBe(false)
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
    await expect(objectExists(keyFor('media-int-test-reject.svg'))).resolves.toBe(false)
  })
})
