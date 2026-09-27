import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * A build-configuration guard for the `next/image` optimizer.
 *
 * ── The bug this exists to prevent recurring ──────────────────────────────────
 * SST bundles a pinned OpenNext to build the Lambdas. SST 4.17.1 hard-codes
 * OpenNext 3.9.14 (Jan 2026), which calls a Next.js internal with the wrong
 * arity once Next reaches 16.2.5:
 *
 *   OpenNext <= 3.10.4  fetchInternalImage(href, req, res, handler)             // 4
 *   Next >= 16.2.5      fetchInternalImage(href, req, res, maxBody, handler)    // 5
 *
 * so `handler` arrives as `undefined` and EVERY optimized local image 500s on a
 * deployed stage. It shipped green on 2026-09-26 because nothing could see it:
 * Lighthouse, Playwright and these integration tests all exercise `next start`,
 * which uses Next's OWN optimizer, never OpenNext's. sst.config.ts therefore
 * pins `openNextVersion` forward to a release carrying the upstream fix
 * (@opennextjs/aws 4.0.0+; there is no 3.x backport).
 *
 * ── Why a static test and not just the post-deploy smoke check ────────────────
 * scripts/smoke-image-optimizer.mjs proves the real thing on a real stage, but
 * it can only run when that stage HAS an upload — production's library is empty
 * until the client fills it, so today it would skip there. This catches the
 * dangerous edit (removing or lowering the pin) at PR time instead, on every
 * run, with no AWS involved.
 *
 * If you are here because this test failed after deleting the pin: that is the
 * point. Delete the pin only once SST's own DEFAULT_OPEN_NEXT_VERSION is >= the
 * floor below, and then change this test to assert SST's default instead.
 */

/** `"4.1.5"` → `[4, 1, 5]`, ignoring any prerelease/build suffix. */
function parseVersion(version: string): [number, number, number] {
  const [core] = version.split(/[-+]/)
  const [major = 0, minor = 0, patch = 0] = core.split('.').map((part) => Number(part))
  return [major, minor, patch]
}

/** True when `a >= b`. */
function isAtLeast(a: string, b: string): boolean {
  const left = parseVersion(a)
  const right = parseVersion(b)
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i]
  }
  return true
}

/** The Next.js release that changed `fetchInternalImage`'s signature. */
const NEXT_SIGNATURE_CHANGE = '16.2.5'
/** The first OpenNext release that branches on the Next version (no 3.x backport exists). */
const OPEN_NEXT_FLOOR = '4.0.0'

const repoRoot = path.resolve(__dirname, '../..')

function installedNextVersion(): string {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'node_modules/next/package.json'), 'utf8'),
  ) as { version: string }
  return pkg.version
}

function pinnedOpenNextVersion(): string | undefined {
  // sst.config.ts cannot be imported here: it runs inside SST's own runtime and
  // references globals ($app, $util, sst.*) that do not exist under vitest. The
  // pin is a literal, so reading it as text is both sufficient and stable.
  const source = fs.readFileSync(path.join(repoRoot, 'sst.config.ts'), 'utf8')
  return /^\s*openNextVersion:\s*'([^']+)'/m.exec(source)?.[1]
}

describe('the OpenNext build that produces the image optimizer', () => {
  it('is new enough for the installed Next.js, or every optimized image 500s on Lambda', () => {
    const nextVersion = installedNextVersion()
    const pinned = pinnedOpenNextVersion()

    if (!isAtLeast(nextVersion, NEXT_SIGNATURE_CHANGE)) {
      // Older Next: the 4-arg call is correct, so SST's own default is fine and
      // a pin is not required. Nothing to assert.
      expect(pinned === undefined || isAtLeast(pinned, OPEN_NEXT_FLOOR)).toBe(true)
      return
    }

    expect(
      pinned,
      `next@${nextVersion} needs OpenNext >= ${OPEN_NEXT_FLOOR}, but sst.config.ts pins no ` +
        `openNextVersion — SST would fall back to its own default (3.9.14 as of SST 4.17.1) ` +
        `and every /_next/image request for a /media/** src would return 500 on the deployed ` +
        `stages while CI stayed green.`,
    ).toBeDefined()

    expect(
      isAtLeast(pinned!, OPEN_NEXT_FLOOR),
      `sst.config.ts pins openNextVersion '${pinned}', but next@${nextVersion} requires ` +
        `>= ${OPEN_NEXT_FLOOR} (the first release that passes five arguments to ` +
        `fetchInternalImage).`,
    ).toBe(true)
  })

  it('agrees with the Next.js signature it was pinned for', () => {
    // Pins the upstream fact the pin depends on, so a Next upgrade that moves
    // the goalposts again is caught here rather than on a deployed stage.
    const optimizer = fs.readFileSync(
      path.join(repoRoot, 'node_modules/next/dist/server/image-optimizer.js'),
      'utf8',
    )
    const signature = /async function fetchInternalImage\(([^)]*)\)/.exec(optimizer)?.[1]
    expect(signature, 'Next no longer exports fetchInternalImage under that name').toBeDefined()

    const parameters = signature!.split(',').map((p) => p.trim())
    expect(
      parameters,
      `fetchInternalImage now takes ${parameters.length} parameters (${signature}). If this ` +
        `changed, OpenNext's version branch may no longer match — re-check the pinned ` +
        `openNextVersion in sst.config.ts against the deployed optimizer before shipping.`,
    ).toHaveLength(5)
  })
})
