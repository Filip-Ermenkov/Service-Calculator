#!/usr/bin/env node
/**
 * The production-dependency audit GATE.
 *
 * Replaces a bare `npm audit --omit=dev --audit-level=high`, which had no way to
 * accept an advisory that has no fix. The only alternatives npm offers are to
 * lower the threshold (which would also have waved through the ten `undici`
 * highs we fixed on 2026-10-03) or to let the gate stay red, which trains people
 * to ignore it. Neither is acceptable for the gate that stands between a
 * published CVE and the Lambda.
 *
 * So: `high`/`critical` in the PRODUCTION tree still fails the build, and an
 * advisory may be accepted ONLY by naming it below with a reason, the evidence
 * for that reason, and a date by which it must be looked at again.
 *
 * Three ways this fails, on purpose:
 *   1. a high/critical advisory that is NOT in the allowlist          → new risk
 *   2. an allowlist entry that the audit no longer reports            → stale, delete it
 *   3. an allowlist entry past its `reviewBy` date                    → re-justify it
 *
 * (2) and (3) are what stop an "accepted" advisory from quietly becoming
 * permanent, which is the usual failure of allowlists.
 *
 * Dev-only advisories are still excluded (`--omit=dev`): eslint/playwright/vitest
 * tooling ships in no deploy artifact. The non-blocking full-tree audit in
 * ci.yml continues to surface those for a human.
 */

import { execSync } from 'node:child_process'

/**
 * Accepted high/critical advisories in the production tree.
 *
 * Each entry must answer: why can this not be fixed, and why is it not
 * exploitable HERE? "Upstream hasn't patched it" alone is not a reason to ship.
 */
const ALLOWLIST = [
  {
    ghsa: 'GHSA-vfj7-8cjw-p6xm',
    package: 'braces',
    title: 'braces vulnerable to stack exhaustion via deeply nested patterns',
    reason:
      'No patched version exists. braces 3.0.3 (2024-05-21) is the latest release on npm and ' +
      'the advisory range is `*`, so there is nothing to upgrade to and no override can help. ' +
      'It reaches the production tree only transitively, by two paths: ' +
      '@payloadcms/next -> sass -> chokidar -> braces, and ' +
      '@payloadcms/storage-s3 -> @payloadcms/plugin-cloud-storage -> find-node-modules -> ' +
      'findup-sync -> micromatch -> braces.',
    evidence:
      'Neither path is deployed. Verified 2026-10-03 against the built artifact in ' +
      '.open-next/server-functions: braces, micromatch, sass, chokidar, find-node-modules and ' +
      'findup-sync are present as ZERO directories, `require("braces")` appears 0 times, and ' +
      'the only @payloadcms packages shipped as node_modules are db-postgres and next ' +
      '(storage-s3 is esbuild-bundled, and `find-node-modules` appears 0 times in the bundle). ' +
      'sass compiles the admin SCSS during `next build` and is absent from the Lambda; ' +
      'the glob patterns these tools expand are internal paths, never request input. ' +
      'The advisory needs an attacker-supplied deeply nested brace pattern, and there is no ' +
      'code path from a visitor request to any of them.',
    reviewBy: '2026-12-31',
  },
]

function runAudit() {
  // npm audit exits non-zero whenever it finds anything, so the exit code is not
  // the signal here — the JSON on stdout is. Only a failure to produce parseable
  // JSON is fatal.
  let stdout
  try {
    // One fixed command string through `execSync`, deliberately: Node 24 on
    // Windows refuses to execFile `npm.cmd` without a shell (EINVAL), and
    // passing an args ARRAY with `shell: true` is deprecated (DEP0190). A
    // single literal string with no interpolation has no injection surface.
    stdout = execSync('npm audit --omit=dev --json', {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    stdout = err.stdout
    if (!stdout) {
      console.error(`[audit] could not run npm audit: ${err?.message ?? err}`)
      process.exit(1)
    }
  }
  try {
    return JSON.parse(stdout)
  } catch {
    console.error('[audit] npm audit did not return parseable JSON. Raw output:')
    console.error(stdout.slice(0, 4000))
    process.exit(1)
  }
}

/** `https://github.com/advisories/GHSA-xxxx` → `GHSA-xxxx`. */
const ghsaFromUrl = (url) => /\/(GHSA-[a-z0-9-]+)\s*$/i.exec(url ?? '')?.[1]

function main() {
  const report = runAudit()
  const vulnerabilities = report.vulnerabilities ?? {}

  /** Every high/critical advisory the audit reports, keyed by GHSA id. */
  const found = new Map()
  for (const [name, vuln] of Object.entries(vulnerabilities)) {
    if (vuln.severity !== 'high' && vuln.severity !== 'critical') continue
    for (const via of vuln.via) {
      if (typeof via !== 'object') continue // "depends on vulnerable X" — not its own advisory
      const ghsa = ghsaFromUrl(via.url)
      if (!ghsa) continue
      if (!found.has(ghsa)) {
        found.set(ghsa, { ghsa, package: via.name ?? name, severity: via.severity, title: via.title, url: via.url })
      }
    }
  }

  const allowed = new Map(ALLOWLIST.map((entry) => [entry.ghsa, entry]))
  const today = new Date().toISOString().slice(0, 10)

  const unexpected = [...found.values()].filter((a) => !allowed.has(a.ghsa))
  const stale = ALLOWLIST.filter((entry) => !found.has(entry.ghsa))
  const expired = ALLOWLIST.filter((entry) => found.has(entry.ghsa) && entry.reviewBy < today)

  const counts = report.metadata?.vulnerabilities ?? {}
  console.log(
    `[audit] production tree: ${counts.critical ?? 0} critical, ${counts.high ?? 0} high, ` +
      `${counts.moderate ?? 0} moderate, ${counts.low ?? 0} low`,
  )
  console.log(
    `[audit] ${found.size} distinct high/critical advisor${found.size === 1 ? 'y' : 'ies'}; ` +
      `${allowed.size} accepted by the allowlist in this file.`,
  )

  let failed = false

  if (unexpected.length > 0) {
    failed = true
    console.error(`\n[audit] FAIL — ${unexpected.length} high/critical advisory not accepted:`)
    for (const a of unexpected) {
      console.error(`  • ${a.ghsa}  ${a.package}  (${a.severity})`)
      console.error(`      ${a.title}`)
      console.error(`      ${a.url}`)
    }
    console.error(
      '\n  Fix it (upgrade, or pin a patched transitive version via "overrides" in\n' +
        '  package.json — that is how the undici and fast-uri advisories were cleared).\n' +
        '  If it genuinely cannot be fixed, add it to ALLOWLIST in this file WITH the\n' +
        '  evidence that it is not reachable in the deployed artifact. Do not lower the\n' +
        '  severity threshold.',
    )
  }

  if (stale.length > 0) {
    failed = true
    console.error(`\n[audit] FAIL — ${stale.length} allowlist entr${stale.length === 1 ? 'y' : 'ies'} no longer reported:`)
    for (const entry of stale) console.error(`  • ${entry.ghsa} (${entry.package}) — fixed or gone; delete this entry.`)
    console.error('\n  An allowlist that outlives the problem hides the next one.')
  }

  if (expired.length > 0) {
    failed = true
    console.error(`\n[audit] FAIL — ${expired.length} allowlist entr${expired.length === 1 ? 'y' : 'ies'} past review date:`)
    for (const entry of expired) {
      console.error(`  • ${entry.ghsa} (${entry.package}) — reviewBy ${entry.reviewBy}, today ${today}.`)
    }
    console.error(
      '\n  Re-check whether a fix now exists and whether the evidence still holds, then\n' +
        '  move the date forward. This is deliberately not automatic.',
    )
  }

  if (failed) {
    process.exitCode = 1
    return
  }

  for (const entry of ALLOWLIST) {
    console.log(`[audit] accepted: ${entry.ghsa} (${entry.package}) — review by ${entry.reviewBy}`)
  }
  console.log('[audit] OK — no unaccepted high/critical advisories in the production tree.')
}

main()
