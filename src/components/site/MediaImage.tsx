import Image from 'next/image'

/**
 * A CMS photo, served through `next/image` (TECHSPEC §6.11 — the perf item the
 * media-CDN slice unblocked). One component for all four public surfaces (home
 * service cards, the service hero, the projects grid, careers cards) so the
 * decisions below are made once.
 *
 * ── Why `fill` rather than intrinsic width/height ─────────────────────────────
 * Every place a CMS photo appears is a FIXED-HEIGHT box that the image must
 * cover (`.service-card-img`/`.career-card-img` are 200 px, the projects card
 * 180 px, the service hero 200 px), and `.media-cover` already applies
 * `object-fit: cover`. `fill` is Next's idiom for exactly that, and it needs no
 * CSS change: `.img-ph`, the wrapper in all four places, is already
 * `position: relative; overflow: hidden`.
 *
 * It is also the more honest choice here. Payload does record real pixel
 * dimensions without `sharp` (a 743×743 JPEG reads correctly), but they are
 * whatever was uploaded — the CI fixture is a 1×1 PNG — and intrinsic sizing
 * would let a degenerate value drive layout. With `fill` the container is the
 * single source of geometry and the photo can never distort it.
 *
 * ── `sizes` is REQUIRED, not decorative ───────────────────────────────────────
 * With `fill` and no `sizes`, Next assumes the image spans the viewport and
 * ships the largest srcset entry (up to 3840 px) to a 200 px card — i.e. it
 * would make page weight WORSE than the `<img>` this replaces. Each caller
 * passes the widths its own grid actually produces, so the prop is mandatory in
 * the type rather than defaulted.
 *
 * ── How the bytes are fetched on a deployed stage ─────────────────────────────
 * `src` stays the relative `/media/<key>` URL (src/lib/media/publicUrl.ts), so
 * Next treats it as a LOCAL image, governed by `images.localPatterns` in
 * next.config.ts. On Lambda the optimizer resolves a local path through
 * OpenNext's S3 loader, which reads `BUCKET_NAME`/`BUCKET_KEY_PREFIX` — SST
 * points those at its own assets bucket, where our media does not live, so
 * `sst.config.ts` repoints them at the media bucket (see the `imageOptimizer`
 * transform there). The URL path is the S3 key, so the loader needs no
 * translation and no HTTP round-trip back through CloudFront.
 */
export function MediaImage({
  src,
  alt,
  sizes,
  priority = false,
}: {
  /** The stored media URL — always relative, always `/media/…`. */
  src: string
  /** Required by the Media collection, so never a decorative empty string by accident. */
  alt: string
  /** The rendered widths this image actually takes, per breakpoint. */
  sizes: string
  /** Set only for an above-the-fold image (the service hero); everything else stays lazy. */
  priority?: boolean
}) {
  return <Image src={src} alt={alt} fill sizes={sizes} className="media-cover" priority={priority} />
}

/**
 * The `sizes` each surface needs, kept next to each other so they can be read
 * against the grids in globals.css (`.container` is 1280 px max):
 *   • services  `auto-fill, minmax(min(100%, 20rem), 1fr)` → at most 4 × ~320 px
 *   • careers   `auto-fill, minmax(min(100%, 18rem), 1fr)` → at most 4 × ~320 px
 *   • projects  `auto-fill, minmax(min(100%, 15rem), 1fr)` → at most 5 × ~256 px
 *   • hero      one column below 820 px, else `clamp(220px, 24vw, 300px)`
 */
export const MEDIA_SIZES = {
  serviceCard: '(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 320px',
  careerCard: '(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 320px',
  projectCard: '(max-width: 640px) 100vw, (max-width: 1024px) 33vw, 256px',
  serviceHero: '(max-width: 819px) 100vw, 300px',
} as const
