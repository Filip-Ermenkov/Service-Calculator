#!/usr/bin/env node
/**
 * Print the Lighthouse category scores of a CI run.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────
 * `lhci assert` prints ONLY the assertions that fail or warn. A budget that
 * passes therefore produces no number anywhere — and `lighthouserc.cjs` uploads
 * its reports to `./.lighthouseci` on the runner, which nothing ever collected,
 * so they were discarded with the machine. The practical consequence, found
 * 2026-09-26 while trying to re-calibrate the performance floor after the
 * next/image slice: there was no way to answer "what is the score now?" without
 * changing CI first. A budget nobody can re-derive from a measurement is a
 * number that slowly stops meaning anything.
 *
 * So this reads the manifest LHCI writes for the filesystem target (verified in
 * the installed @lhci/cli source, `src/upload/upload.js`: each entry carries
 * `url`, `isRepresentativeRun` and a `summary` of category → score) and prints a
 * table to stdout and, when running in Actions, to the job summary.
 *
 * It reports the REPRESENTATIVE run per URL — the median run LHCI itself picks
 * out of the three, which is the same one its assertions are reported against,
 * rather than a best-of that would flatter the result.
 *
 * Never fails the build: the gate is `lhci assert`, and a reporting helper that
 * can turn a green run red would be worse than no reporting at all.
 */

import fs from 'node:fs'
import path from 'node:path'

const DIR = process.argv[2] ?? '.lighthouseci'
const CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo']

/** `http://localhost:3000/en/projects` → `/en/projects` (the part that differs). */
function shortUrl(url) {
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}

function pct(score) {
  return typeof score === 'number' ? String(Math.round(score * 100)) : '—'
}

function main() {
  const manifestPath = path.join(DIR, 'manifest.json')
  if (!fs.existsSync(manifestPath)) {
    console.log(`[lighthouse-summary] no ${manifestPath} — nothing to report.`)
    return
  }

  /** @type {{url: string, isRepresentativeRun: boolean, summary: Record<string, number>}[]} */
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (err) {
    console.log(`[lighthouse-summary] could not read the manifest: ${err?.message ?? err}`)
    return
  }

  const rows = manifest.filter((entry) => entry.isRepresentativeRun)
  if (rows.length === 0) {
    console.log('[lighthouse-summary] the manifest has no representative run.')
    return
  }

  const header = ['URL', ...CATEGORIES.map((c) => (c === 'best-practices' ? 'best-pract.' : c))]
  const body = rows.map((entry) => [
    shortUrl(entry.url),
    ...CATEGORIES.map((c) => pct(entry.summary?.[c])),
  ])

  // Plain text for the job log.
  const widths = header.map((h, i) =>
    Math.max(h.length, ...body.map((row) => row[i].length)),
  )
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ')
  console.log('\nLighthouse — representative run per URL (scores out of 100)\n')
  console.log(line(header))
  console.log(widths.map((w) => '-'.repeat(w)).join('  '))
  for (const row of body) console.log(line(row))
  console.log('')

  // Markdown for the Actions run page, where it is actually read.
  const summaryFile = process.env.GITHUB_STEP_SUMMARY
  if (!summaryFile) return
  const md = [
    '### Lighthouse',
    '',
    'Representative (median) run per URL, scores out of 100.',
    '',
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...body.map((row) => `| ${row.join(' | ')} |`),
    '',
  ].join('\n')
  try {
    fs.appendFileSync(summaryFile, `${md}\n`)
  } catch (err) {
    console.log(`[lighthouse-summary] could not write the job summary: ${err?.message ?? err}`)
  }
}

main()
