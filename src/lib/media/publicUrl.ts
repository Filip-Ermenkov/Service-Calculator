/**
 * The public URL contract for uploaded media (TECHSPEC §6.2 "Media delivery").
 *
 * ── The one rule ──────────────────────────────────────────────────────────────
 * A media file's public URL path is `/` + its S3 object key, and every key
 * starts with the collection prefix `media/`. So the object `media/roof.jpg`
 * is served at `/media/roof.jpg` — same origin as the site, no host to
 * configure, no CORS.
 *
 * Why the path IS the key: CloudFront forwards the request path to an S3 origin
 * unchanged, so a `/media/*` cache behaviour pointed straight at the bucket
 * (sst.config.ts) needs no edge function to translate URLs into keys, and a
 * local `next dev` can serve the very same URLs with one rewrite to S3Mock
 * (next.config.ts). The prefix is what makes that mapping total: with objects
 * at the bucket root there would be nothing for `/media/*` to match against.
 *
 * ── Why media no longer goes through the Web Lambda ───────────────────────────
 * Until this change Payload's own file route (`/api/media/file/<name>`) proxied
 * every byte through the Next/Payload function, which OpenNext builds BUFFERED:
 * a Lambda response is capped at 6 MB after base64, so a photo over ~4.5 MB
 * uploaded fine (straight to S3) and then 502'd for every visitor — the reason
 * for the 4 MB cap in src/collections/Media.ts. Serving the bucket from a
 * CloudFront behaviour removes that ceiling and the per-view invocation, and is
 * the prerequisite for `next/image` (OpenNext's optimizer cannot fetch a
 * relative `/api/…` URL from the app, but it can fetch `https://<site>/media/…`).
 *
 * This module is pure (no Payload, no React) so payload.config.ts,
 * next.config.ts, sst.config.ts and the tests all read the same three constants.
 */

/** S3 key prefix (folder) every media object is stored under — no slashes. */
export const MEDIA_S3_PREFIX = 'media'

/** URL path prefix media is served from; equals `/${MEDIA_S3_PREFIX}` by design. */
export const MEDIA_PUBLIC_PATH = `/${MEDIA_S3_PREFIX}`

/** CloudFront path pattern for the media cache behaviour (sst.config.ts). */
export const MEDIA_CDN_PATH_PATTERN = `${MEDIA_PUBLIC_PATH}/*`

/**
 * Browser caching for media responses. Object keys are effectively immutable —
 * Payload never overwrites a filename with different bytes (a re-upload with the
 * same name gets a `-1` suffix, a replaced file's old object is deleted) — but a
 * key CAN be reused after a delete, so this stays at one hour rather than
 * `immutable`. The edge TTL is CloudFront's CachingOptimized policy (one day,
 * purged on every media change by the revalidate hooks), so this header only
 * has to speak to browsers.
 */
export const MEDIA_CACHE_CONTROL = 'public, max-age=3600'

/**
 * Public URL for a stored media file — the `url` Payload persists and returns.
 *
 * `prefix` is the per-document prefix the storage plugin records on upload
 * (`media` for everything created since this contract exists). A document with
 * no prefix predates it: its object sits at the bucket root, where nothing
 * serves it any more, so it is still given the canonical URL shape (a clean 404
 * at the edge rather than a URL nothing recognises) — re-upload is the fix.
 * The filename is URL-encoded exactly as the storage adapter's own URL builder
 * does; Payload already sanitises filenames, so this is belt-and-braces.
 */
export function mediaPublicUrl(args: { filename: string; prefix?: string | null }): string {
  const prefix = normalisePrefix(args.prefix) || MEDIA_S3_PREFIX
  const filename = encodeURIComponent(args.filename)
  return `/${prefix}/${filename}`
}

/** `/media//` → `media`; `media/` → `media`; blank → ''. Mirrors the plugin's sanitizePrefix. */
function normalisePrefix(prefix: string | null | undefined): string {
  return (prefix ?? '')
    .split('/')
    .filter((s) => s.length > 0)
    .join('/')
}
