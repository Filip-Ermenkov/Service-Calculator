#!/usr/bin/env node
/**
 * Migration-ledger verifier — the fail-closed guard around `payload migrate` in
 * the deploy pipeline (AWS Well-Architected: Operational Excellence / Reliability).
 *
 * ── The gap this closes (found 2026-09-13 by reading the CI logs, not the docs) ──
 * `payload migrate` is NOT fail-closed in a non-interactive environment. When the
 * target database has ever been used in Payload's dev `push` mode, its
 * `payload_migrations` table carries a marker row (`name = 'dev', batch = -1`),
 * and `migrate` then asks an INTERACTIVE question:
 *
 *   "It looks like you've run Payload in dev mode … data loss will occur.
 *    Would you like to proceed? (y/N)"
 *
 * With no TTY the prompt is cancelled and Payload calls `process.exit(0)` —
 * i.e. the step PASSES while applying NOTHING (verified in the installed
 * @payloadcms/drizzle/dist/migrate.js). That is exactly what happened to the
 * staging deploy on every push from 2026-08-01 to 2026-09-10: the local `.env`
 * pointed at the staging Neon branch, `next dev` pushed the schema and inserted
 * the marker, and from then on each CI migrate step sat on the prompt for ~5
 * minutes, exited 0, and deployed code against a schema no migration had put
 * there. Payload's own docs say "do not mix push and migrations" on one database;
 * this script is what makes CI notice when that rule has been broken.
 *
 * ── What it asserts ──
 *   1. (always)  no `batch = -1` dev-push marker is present.
 *   2. (default) every committed migration file in src/migrations/ has a row in
 *      `payload_migrations`, i.e. is recorded as applied. `--pre` skips this so
 *      the same script can run BEFORE `payload migrate` (fail fast on the marker
 *      with a precise remediation) and AFTER it (prove the post-condition).
 *
 * It talks to Postgres directly with `pg` — it deliberately does NOT boot Payload,
 * because a Payload boot outside NODE_ENV=production would itself PUSH the schema
 * and re-create the very marker this guards against.
 *
 * Usage:  DATABASE_URL=<direct/unpooled url> node scripts/verify-migrations.mjs [--pre]
 *         (or `npm run migrate:verify [-- --pre]`)
 * Exit:   0 = ledger is consistent · 1 = a check failed · 2 = usage/connection error
 */

import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import pg from 'pg'

/** Mirrors payload's readMigrationFiles(): *.ts / *.js in the dir, minus index.* */
export function readMigrationNames(migrationDir) {
  if (!fs.existsSync(migrationDir)) return []
  return fs
    .readdirSync(migrationDir)
    .sort()
    .filter(
      (f) => (f.endsWith('.ts') || f.endsWith('.js')) && f !== 'index.ts' && f !== 'index.js',
    )
    .map((f) => f.split('.')[0])
}

/**
 * Pure comparison of the committed migration files against the ledger rows.
 * Exported so the logic is unit-tested without a database.
 *
 * @param {string[]} files  migration names from src/migrations
 * @param {{ name: string, batch: number | string | null }[]} rows  payload_migrations rows
 * @param {{ pre?: boolean }} [opts]
 * @returns {{ ok: boolean, problems: string[], warnings: string[], devMarker: boolean, missing: string[], unknown: string[] }}
 */
export function diffLedger(files, rows, opts = {}) {
  const problems = []
  const warnings = []

  const devMarker = rows.some((r) => Number(r.batch) === -1)
  if (devMarker) {
    problems.push(
      'A dev-push marker (name="dev", batch=-1) is present in payload_migrations. ' +
        'This database has been used with Payload in dev/push mode, so `payload migrate` ' +
        'will NOT apply anything here (it prompts, and exits 0 without a TTY).',
    )
  }

  const applied = new Set(rows.filter((r) => Number(r.batch) !== -1).map((r) => r.name))
  const missing = files.filter((name) => !applied.has(name))
  const unknown = [...applied].filter((name) => !files.includes(name)).sort()

  if (!opts.pre && missing.length > 0) {
    problems.push(
      `${missing.length} committed migration(s) are not recorded as applied: ${missing.join(', ')}`,
    )
  }
  if (unknown.length > 0) {
    warnings.push(
      `${unknown.length} ledger row(s) have no matching file in src/migrations (a deleted or renamed migration?): ${unknown.join(', ')}`,
    )
  }

  return { ok: problems.length === 0, problems, warnings, devMarker, missing, unknown }
}

const REMEDIATION = `
How to fix a dev-push marker on a DEPLOYED stage's database (staging/production):
  1. Make sure no local .env / dev server / test run points at this database —
     local development belongs on the docker-compose Postgres or a personal Neon
     branch, never on a stage branch (Payload: "do not mix push and migrations").
  2. Reconcile the ledger by hand against the DIRECT (unpooled) connection string.
     If the schema is already current because push created it, mark the missing
     migration(s) as applied instead of re-running their DDL:
       DELETE FROM payload_migrations WHERE batch = -1;
       INSERT INTO payload_migrations (name, batch, created_at, updated_at)
         VALUES ('<migration name>', <next batch number>, now(), now());
     (This is the equivalent of Flyway "baseline" / Prisma "migrate resolve --applied".)
  3. Re-run: npm run migrate:verify
`

function printTable(files, rows) {
  const byName = new Map(rows.map((r) => [r.name, r]))
  const width = Math.max(4, ...files.map((f) => f.length), ...rows.map((r) => r.name.length))
  const line = (name, batch, ran) =>
    `  ${name.padEnd(width)}  ${String(batch ?? '').padStart(5)}  ${ran}`
  console.log(line('Name', 'Batch', 'Ran'))
  console.log(`  ${'-'.repeat(width)}  -----  ---`)
  for (const f of files) {
    const r = byName.get(f)
    console.log(line(f, r?.batch, r ? 'Yes' : 'No'))
  }
  for (const r of rows) {
    if (!files.includes(r.name)) {
      console.log(line(r.name, r.batch, Number(r.batch) === -1 ? 'DEV MARKER' : '(no file)'))
    }
  }
}

async function main() {
  const pre = process.argv.includes('--pre')
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('::error title=migrate:verify::DATABASE_URL is not set.')
    process.exit(2)
  }
  if (/-pooler\./.test(url)) {
    // Not fatal for a SELECT, but a strong hint the caller is about to run DDL
    // through Neon's PgBouncer pooler, which breaks migrations.
    console.warn(
      '::warning title=migrate:verify::DATABASE_URL looks like a Neon POOLED url (-pooler). Migrations must use the DIRECT url.',
    )
  }

  const migrationDir = fileURLToPath(new URL('../src/migrations/', import.meta.url))
  const files = readMigrationNames(migrationDir)
  if (files.length === 0) {
    console.error(`::error title=migrate:verify::no migration files found in ${migrationDir}`)
    process.exit(2)
  }

  const client = new pg.Client({ connectionString: url })
  try {
    await client.connect()
  } catch (err) {
    console.error(
      `::error title=migrate:verify::could not connect to the database: ${err?.message ?? err}`,
    )
    process.exit(2)
  }

  try {
    const exists = await client.query("SELECT to_regclass('payload_migrations') AS t")
    if (!exists.rows[0]?.t) {
      if (pre) {
        // A brand-new database: nothing to verify yet; `payload migrate` creates the table.
        console.log(
          '✅ migrate:verify (pre): no payload_migrations table yet — fresh database, nothing to check.',
        )
        return
      }
      console.error(
        '::error title=migrate:verify::payload_migrations table does not exist after `payload migrate` — nothing was applied.',
      )
      process.exit(1)
    }

    const { rows } = await client.query(
      'SELECT name, batch FROM payload_migrations ORDER BY created_at, name',
    )
    const result = diffLedger(files, rows, { pre })

    console.log(
      `migrate:verify${pre ? ' (pre-flight)' : ''} — ${files.length} migration file(s), ${rows.length} ledger row(s)`,
    )
    printTable(files, rows)
    for (const w of result.warnings) console.warn(`::warning title=migrate:verify::${w}`)

    if (!result.ok) {
      for (const p of result.problems) console.error(`::error title=migrate:verify::${p}`)
      if (result.devMarker) console.error(REMEDIATION)
      process.exit(1)
    }
    console.log(
      pre
        ? '✅ migrate:verify (pre): no dev-push marker — safe to run `payload migrate`.'
        : '✅ migrate:verify: every committed migration is recorded as applied.',
    )
  } finally {
    await client.end().catch(() => {})
  }
}

// Only run when executed directly (so tests can import diffLedger without side effects).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`::error title=migrate:verify::${err?.message ?? err}`)
    process.exit(2)
  })
}
