import { describe, expect, it } from 'vitest'

import {
  MEDIA_CACHE_CONTROL,
  MEDIA_CDN_PATH_PATTERN,
  MEDIA_PUBLIC_PATH,
  MEDIA_S3_PREFIX,
  mediaPublicUrl,
} from '@/lib/media/publicUrl'

// The three constants in src/lib/media/publicUrl.ts are consumed by four
// different surfaces — payload.config.ts (the S3 prefix + URL generation),
// next.config.ts (the local S3Mock rewrite + next/image allow-list),
// sst.config.ts (the CloudFront `/media/*` behaviour) and the tests — and the
// whole design rests on one invariant: a file's public URL path is `/` + its
// S3 key. These pin that invariant and the URL builder's edge cases; the real
// Payload round-trip (stored prefix → key → url) is in media.int.spec.ts.
describe('media/publicUrl.ts — the "URL path is the S3 key" contract', () => {
  it('the public path, the S3 prefix and the CDN pattern are the same name', () => {
    expect(MEDIA_S3_PREFIX).toBe('media')
    expect(MEDIA_S3_PREFIX).not.toContain('/')
    expect(MEDIA_PUBLIC_PATH).toBe(`/${MEDIA_S3_PREFIX}`)
    expect(MEDIA_CDN_PATH_PATTERN).toBe(`${MEDIA_PUBLIC_PATH}/*`)
  })

  it('builds a relative URL from the stored prefix + the URL-encoded filename', () => {
    expect(mediaPublicUrl({ filename: 'roof.jpg', prefix: 'media' })).toBe('/media/roof.jpg')
    expect(mediaPublicUrl({ filename: 'roof top.jpg', prefix: 'media' })).toBe('/media/roof%20top.jpg')
    expect(mediaPublicUrl({ filename: 'Wärmepumpe.png', prefix: 'media' })).toBe(
      '/media/W%C3%A4rmepumpe.png',
    )
  })

  it('the URL path, decoded, is exactly the S3 key (what CloudFront forwards to the bucket)', () => {
    const url = mediaPublicUrl({ filename: 'roof top.jpg', prefix: 'media' })
    expect(decodeURIComponent(url.slice(1))).toBe('media/roof top.jpg')
  })

  it('normalises a sloppy prefix the same way the storage plugin does', () => {
    expect(mediaPublicUrl({ filename: 'a.png', prefix: '/media/' })).toBe('/media/a.png')
    expect(mediaPublicUrl({ filename: 'a.png', prefix: 'media//sub' })).toBe('/media/sub/a.png')
  })

  it('a document with no prefix (pre-contract upload) still gets the canonical shape', () => {
    // Its object sits at the bucket root, which nothing serves any more — the
    // canonical URL 404s cleanly at the edge and the fix is to re-upload. What
    // must NOT happen is a URL nothing recognises (e.g. `//a.png`).
    expect(mediaPublicUrl({ filename: 'a.png' })).toBe('/media/a.png')
    expect(mediaPublicUrl({ filename: 'a.png', prefix: null })).toBe('/media/a.png')
    expect(mediaPublicUrl({ filename: 'a.png', prefix: '' })).toBe('/media/a.png')
  })

  it('browser caching is public and bounded (keys can be reused after a delete, so never immutable)', () => {
    expect(MEDIA_CACHE_CONTROL).toMatch(/^public, max-age=\d+$/)
    expect(MEDIA_CACHE_CONTROL).not.toContain('immutable')
    expect(Number(/max-age=(\d+)/.exec(MEDIA_CACHE_CONTROL)![1])).toBeLessThanOrEqual(86400)
  })
})
