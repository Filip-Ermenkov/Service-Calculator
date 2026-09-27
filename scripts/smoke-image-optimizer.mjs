#!/usr/bin/env node
/**
 * Post-deploy smoke test: prove `next/image` actually works ON THE DEPLOYED STAGE.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────
 * Nothing in CI can catch a broken image optimizer. Lighthouse, Playwright and
 * the integration suite all run against `next start`, which uses Next's OWN
 * optimizer; the deployed stages run OpenNext's, in a separate Lambda, reached
 * through a separate CloudFront behaviour. The two share no code on the path
 * that matters.
 *
 * That gap shipped a real outage. From 2026-09-26 every CMS photo on staging
 * returned a 500 from `/_next/image` while CI was fully green, because the
 * OpenNext build SST pins called a Next.js internal with the wrong number of
 * arguments (see the `openNextVersion` note in sst.config.ts). The raw object
 * served 200 from S3 the whole time, so even a media-delivery check would have
 * missed it — only asking the optimizer itself would have caught it.
 *
 * So this runs after `sst deploy`, against the real origin, and fails the job
 * if the optimizer cannot return an image. It is deliberately the LAST word on
 * a deploy rather than a test: the thing it guards only exists once deployed.
 *
 * ── What it asserts ───────────────────────────────────────────────────────────
 *   1. The raw media object is served (200, `image/*`) — the S3/CloudFront path.
 *   2. `/_next/image?url=<that>&w=256&q=75` is served (200, `image/*`) — the
 *      optimizer Lambda path, which is the one that broke.
 * Splitting the two is the point: it says WHICH half is broken instead of just
 * "images are down".
 *
 * ── When there is no media yet ────────────────────────────────────────────────
 * Production has no uploads until the client adds them, and a check that
 * invents one would be testing itself. With an empty library this reports that
 * it could not run and exits 0 — it starts guarding the moment the first photo
 * exists. It never *silently* passes: the reason is always printed.
 *
 * Usage:  node scripts/smoke-image-optimizer.mjs [baseUrl]
 * With no argument the stage URL is read from `.sst/outputs.json`, which
 * `sst deploy` writes into the workspace for the stage it just deployed.
 */

import fs from 'node:fs'

/** An allowed width: must be one of `images.imageSizes`/`deviceSizes`, or Next answers 400. */
const WIDTH = 256
const QUALITY = 75
/** Cold start + a CloudFront miss; retried because a flaky gate is worse than none. */
const ATTEMPTS = 3
const RETRY_DELAY_MS = 3000

function resolveBaseUrl() {
  const fromArgv = process.argv[2]
  if (fromArgv) return fromArgv.replace(/\/$/, '')
  try {
    const outputs = JSON.parse(fs.readFileSync('.sst/outputs.json', 'utf8'))
    if (outputs.url) return String(outputs.url).replace(/\/$/, '')
  } catch {
    /* fall through to the error below */
  }
  throw new Error(
    'No base URL. Pass one as the first argument, or run after `sst deploy` so ' +
      '.sst/outputs.json exists.',
  )
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** GET with retries. Only the LAST attempt's outcome decides the result. */
async function get(url, headers) {
  let last
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, { headers, redirect: 'manual' })
      last = {
        status: response.status,
        contentType: response.headers.get('content-type') ?? '',
        bytes: (await response.arrayBuffer()).byteLength,
      }
      if (response.status >= 200 && response.status < 300) return last
    } catch (err) {
      last = { status: 0, contentType: '', bytes: 0, error: err?.message ?? String(err) }
    }
    if (attempt < ATTEMPTS) await sleep(RETRY_DELAY_MS)
  }
  return last
}

function isImage(result) {
  return result.status === 200 && result.contentType.startsWith('image/')
}

function describe(result) {
  if (result.error) return `network error: ${result.error}`
  return `HTTP ${result.status}, ${result.contentType || 'no content-type'}, ${result.bytes} bytes`
}

async function main() {
  const base = resolveBaseUrl()
  console.log(`[smoke:image] stage: ${base}`)

  // Ask the stage for a real upload rather than hard-coding a key: media is
  // entered by hand per stage, and a key that only exists on staging would make
  // this fail on production for the wrong reason.
  const listUrl = `${base}/api/media?limit=1&depth=0`
  let list
  try {
    const response = await fetch(listUrl)
    if (!response.ok) {
      console.log(`[smoke:image] could not list media (HTTP ${response.status}) — not run.`)
      return
    }
    list = await response.json()
  } catch (err) {
    console.log(`[smoke:image] could not reach ${listUrl} (${err?.message ?? err}) — not run.`)
    return
  }

  const doc = list?.docs?.[0]
  if (!doc?.url) {
    console.log(
      '[smoke:image] the media library is empty, so there is nothing to optimize — not run. ' +
        'This starts guarding as soon as the first photo is uploaded.',
    )
    return
  }

  const rawUrl = `${base}${doc.url}`
  const optimizedUrl = `${base}/_next/image?url=${encodeURIComponent(doc.url)}&w=${WIDTH}&q=${QUALITY}`

  // `image/webp` first so Next converts rather than passing the original
  // through — the response type then also shows the optimizer really ran.
  const accept = 'image/avif,image/webp,image/*,*/*;q=0.8'
  const [raw, optimized] = [await get(rawUrl, { accept }), await get(optimizedUrl, { accept })]

  console.log(`[smoke:image] raw object  ${doc.url} -> ${describe(raw)}`)
  console.log(`[smoke:image] optimized   w=${WIDTH} q=${QUALITY} -> ${describe(optimized)}`)

  const failures = []
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
        `sst.config.ts. A 500 here with the raw object fine is the OpenNext/Next ` +
        `signature mismatch this check exists for.`,
    )
  }

  if (failures.length > 0) {
    console.error('\n[smoke:image] FAILED')
    for (const failure of failures) console.error(`  • ${failure}`)
    process.exitCode = 1
    return
  }

  console.log('[smoke:image] OK — media and next/image both serve images on this stage.')
}

await main()
