#!/usr/bin/env node
/**
 * Post-deploy smoke test: prove `next/image` actually OPTIMIZES on the deployed stage.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────
 * Nothing in CI can catch a broken image optimizer. Lighthouse, Playwright and
 * the integration suite all run against `next start`, which uses Next's OWN
 * optimizer; the deployed stages run OpenNext's, in a separate Lambda, reached
 * through a separate CloudFront behaviour. The two share no code on the path
 * that matters.
 *
 * That gap has now shipped TWO distinct outages, which is why this script checks
 * what it checks:
 *
 *   1. 2026-09-26 — every optimized image returned 500, because the pinned
 *      OpenNext called a Next internal with the wrong arity. Loud, once you
 *      looked. Caught by "is the response an image?".
 *
 *   2. 2026-10-03 — every optimized image returned 200 with the ORIGINAL bytes,
 *      because OpenNext installed an x64 sharp binary into an arm64 Lambda
 *      (`--arch` vs `--cpu`, see open-next.config.ts). `require('sharp')` threw,
 *      and Next CAUGHT it: `imageOptimizer` falls back to "the original image"
 *      rather than failing. Nothing logged. Every response was a valid 200
 *      image. The first version of this script passed it.
 *
 * So "an image came back" is NOT the property worth asserting — "the bytes were
 * actually optimized" is. A silent fallback is the dangerous failure here,
 * because it looks exactly like success in a browser.
 *
 * ── What it asserts ───────────────────────────────────────────────────────────
 * Build artifact (runs always, needs no content — this is what protects
 * production, whose media library is empty until the client fills it):
 *   • the optimizer bundle contains a sharp binary, and it is built for the SAME
 *     architecture as the optimizer Lambda.
 *
 * Live stage (runs when the media library has at least one upload):
 *   • the raw media object is served — the S3/CloudFront half;
 *   • `/_next/image` returns an image — the optimizer Lambda half;
 *   • that image was really transformed: converted to WebP and smaller than the
 *     source. Byte-identical output, or `Cache-Control: max-age=14400` (the
 *     `minimumCacheTTL` default the fallback path sets), is treated as failure.
 *
 * Splitting raw from optimized is deliberate: it says WHICH half broke instead
 * of just "images are down".
 *
 * Usage:  node scripts/smoke-image-optimizer.mjs [baseUrl]
 * With no argument the stage URL is read from `.sst/outputs.json`, which
 * `sst deploy` writes into the workspace for the stage it just deployed.
 */

import fs from 'node:fs'
import path from 'node:path'

/** An allowed width: must be one of `images.imageSizes`/`deviceSizes`, or Next answers 400. */
const WIDTH = 256
const QUALITY = 75
/** Cold start + a CloudFront miss; retried because a flaky gate is worse than none. */
const ATTEMPTS = 3
const RETRY_DELAY_MS = 3000

/**
 * The optimizer Lambda's architecture. SST's default for the image optimizer is
 * arm64 and sst.config.ts does not override it; open-next.config.ts installs
 * sharp for the same value. Change all three together or this fails.
 */
const OPTIMIZER_ARCH = 'arm64'
const BUNDLE_DIR = '.open-next/image-optimization-function'

/** `minimumCacheTTL`'s default — the max-age Next's fallback path stamps on an unoptimized reply. */
const FALLBACK_MAX_AGE = 14400

/**
 * Source types Next returns untouched by design, so WebP conversion must not be
 * demanded of them: the bypass list (SVG/ICO/ICNS/BMP/JXL/HEIC) plus the types
 * that are passed through when animated (GIF/PNG/WebP).
 */
const PASSTHROUGH_TYPES = new Set([
  'image/svg+xml',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/x-icns',
  'image/bmp',
  'image/jxl',
  'image/heic',
  'image/gif',
  'image/apng',
])

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function resolveBaseUrl() {
  const fromArgv = process.argv[2]
  if (fromArgv) return fromArgv.replace(/\/$/, '')
  try {
    const outputs = JSON.parse(fs.readFileSync('.sst/outputs.json', 'utf8'))
    if (outputs.url) return String(outputs.url).replace(/\/$/, '')
  } catch {
    /* fall through */
  }
  throw new Error(
    'No base URL. Pass one as the first argument, or run after `sst deploy` so ' +
      '.sst/outputs.json exists.',
  )
}

/**
 * Check the built bundle ships a sharp binary matching the Lambda architecture.
 * Returns a failure string, or undefined when fine / not checkable.
 *
 * Hard-fails only in CI. A local `open-next` build on Windows cannot install
 * these at all (OpenNext's `mkdtemp` mangles a Windows path), so locally this is
 * reported and moved past rather than failing a developer's run — CI is the
 * authority, exactly as for the Lighthouse Chrome flake.
 */
function checkBundledSharp() {
  const imgDir = path.join(BUNDLE_DIR, 'node_modules', '@img')
  if (!fs.existsSync(BUNDLE_DIR)) {
    console.log(`[smoke:image] no ${BUNDLE_DIR} in the workspace — build check not run.`)
    return
  }
  if (!fs.existsSync(imgDir)) {
    return (
      `The optimizer bundle has no ${imgDir}, so sharp was not installed. OpenNext ` +
      `swallows install failures (it logs "Could not install dependencies" and ` +
      `continues), and Next then silently serves every image unoptimized. Check the ` +
      `"Installing dependencies for image-optimization-function" step in the deploy log.`
    )
  }
  const entries = fs.readdirSync(imgDir)
  const platformPkgs = entries.filter((e) => /^sharp-(libvips-)?linux-/.test(e))
  if (platformPkgs.length === 0) {
    return `${imgDir} contains no sharp platform package (found: ${entries.join(', ') || 'nothing'}).`
  }
  const wrong = platformPkgs.filter((e) => !e.endsWith(`-${OPTIMIZER_ARCH}`))
  if (wrong.length > 0) {
    return (
      `The optimizer bundle ships sharp for the WRONG architecture: ${wrong.join(', ')}, ` +
      `but the Lambda runs ${OPTIMIZER_ARCH}. require('sharp') will throw and Next will ` +
      `silently serve unoptimized originals. See open-next.config.ts — npm selects these ` +
      `packages with --cpu, not --arch.`
    )
  }
  console.log(`[smoke:image] bundle OK — sharp for ${OPTIMIZER_ARCH} (${platformPkgs.join(', ')}).`)
  return
}

/** GET with retries. Only the LAST attempt's outcome decides the result. */
async function get(url, headers) {
  let last
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, { headers, redirect: 'manual' })
      last = {
        status: response.status,
        contentType: (response.headers.get('content-type') ?? '').split(';')[0].trim(),
        cacheControl: response.headers.get('cache-control') ?? '',
        bytes: (await response.arrayBuffer()).byteLength,
      }
      if (response.status >= 200 && response.status < 300) return last
    } catch (err) {
      last = { status: 0, contentType: '', cacheControl: '', bytes: 0, error: err?.message ?? String(err) }
    }
    if (attempt < ATTEMPTS) await sleep(RETRY_DELAY_MS)
  }
  return last
}

const isImage = (r) => r.status === 200 && r.contentType.startsWith('image/')
const describe = (r) =>
  r.error ? `network error: ${r.error}` : `HTTP ${r.status}, ${r.contentType || 'no content-type'}, ${r.bytes} bytes`

async function main() {
  const failures = []

  const bundleProblem = checkBundledSharp()
  if (bundleProblem) {
    if (process.env.CI) failures.push(bundleProblem)
    else console.log(`[smoke:image] (local, not failing) ${bundleProblem}`)
  }

  const base = resolveBaseUrl()
  console.log(`[smoke:image] stage: ${base}`)

  // Ask the stage for a real upload rather than hard-coding a key: media is
  // entered by hand per stage, and a key that only exists on staging would make
  // this fail on production for the wrong reason.
  let list
  try {
    const response = await fetch(`${base}/api/media?limit=1&depth=0`)
    if (!response.ok) {
      console.log(`[smoke:image] could not list media (HTTP ${response.status}) — live check not run.`)
      return finish(failures)
    }
    list = await response.json()
  } catch (err) {
    console.log(`[smoke:image] could not reach the media API (${err?.message ?? err}) — live check not run.`)
    return finish(failures)
  }

  const doc = list?.docs?.[0]
  if (!doc?.url) {
    console.log(
      '[smoke:image] the media library is empty, so there is nothing to optimize — live check ' +
        'not run. The build check above still applies.',
    )
    return finish(failures)
  }

  const accept = 'image/avif,image/webp,image/*,*/*;q=0.8'
  const raw = await get(`${base}${doc.url}`, { accept })
  const optimized = await get(
    `${base}/_next/image?url=${encodeURIComponent(doc.url)}&w=${WIDTH}&q=${QUALITY}`,
    { accept },
  )

  console.log(`[smoke:image] raw object  ${doc.url} -> ${describe(raw)}`)
  console.log(`[smoke:image] optimized   w=${WIDTH} q=${QUALITY} -> ${describe(optimized)}`)

  if (!isImage(raw)) {
    failures.push(
      `The raw media object did not serve an image (${describe(raw)}). The CloudFront ` +
        `/media/* behaviour, the bucket policy or the object key is wrong — see ` +
        `src/lib/media/publicUrl.ts.`,
    )
  }
  if (!isImage(optimized)) {
    failures.push(
      `next/image did not serve an image (${describe(optimized)}). The image optimizer ` +
        `Lambda is broken; check its CloudWatch logs and the openNextVersion pin in ` +
        `sst.config.ts.`,
    )
  }

  // The silent-fallback checks. Only meaningful once both halves served an image
  // and the source is a type Next is supposed to transform.
  if (isImage(raw) && isImage(optimized) && !PASSTHROUGH_TYPES.has(raw.contentType)) {
    const maxAge = Number(/max-age=(\d+)/.exec(optimized.cacheControl)?.[1])
    const looksLikeFallback =
      optimized.bytes === raw.bytes ||
      optimized.contentType === raw.contentType ||
      maxAge === FALLBACK_MAX_AGE

    if (looksLikeFallback) {
      failures.push(
        `next/image returned a 200 but did NOT optimize: ${describe(optimized)} against a ` +
          `${raw.bytes}-byte ${raw.contentType} source (cache-control: ` +
          `${optimized.cacheControl || 'none'}). Next's imageOptimizer catches a failure and ` +
          `falls back to the original image, so this is what a broken sharp looks like — a ` +
          `valid, unoptimized 200. Expected WebP, smaller than the source. ` +
          `max-age=${FALLBACK_MAX_AGE} is the fallback path's fingerprint.`,
      )
    } else if (optimized.bytes >= raw.bytes) {
      failures.push(
        `next/image produced ${optimized.bytes} bytes from a ${raw.bytes}-byte source — ` +
          `optimization ran but made the image no smaller at w=${WIDTH}.`,
      )
    } else {
      const saved = Math.round((1 - optimized.bytes / raw.bytes) * 100)
      console.log(
        `[smoke:image] optimization confirmed — ${raw.contentType} ${raw.bytes}B -> ` +
          `${optimized.contentType} ${optimized.bytes}B (${saved}% smaller).`,
      )
    }
  } else if (isImage(raw) && PASSTHROUGH_TYPES.has(raw.contentType)) {
    console.log(
      `[smoke:image] source is ${raw.contentType}, which Next passes through by design — ` +
        `not asserting a transform.`,
    )
  }

  return finish(failures)
}

function finish(failures) {
  if (failures.length > 0) {
    console.error('\n[smoke:image] FAILED')
    for (const failure of failures) console.error(`  • ${failure}`)
    process.exitCode = 1
    return
  }
  console.log('[smoke:image] OK')
}

await main()
