/**
 * @vitest-environment node
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

// The verifier is a plain ESM script (no Payload boot, see its header). Its pure
// core is exported so the decision logic is pinned here without a database.
import { diffLedger, readMigrationNames } from '../../scripts/verify-migrations.mjs'

// Pure coverage for scripts/verify-migrations.mjs — the fail-closed guard around
// `payload migrate` in the deploy pipeline (.github/workflows/ci.yml).
//
// Why this matters enough to pin: `payload migrate` prompts and then exits 0 when
// the target database carries a dev-push marker (batch = -1), so the CI step
// "passed" for six weeks while applying nothing on staging. These cases are the
// contract the workflow relies on: a marker is ALWAYS a failure, a missing
// migration is a failure after the apply (but not in --pre), and an orphan ledger
// row is only a warning.

const FILES = [
  '20260707_153821_initial',
  '20260717_164130_phase2b_slug_service_snapshot',
  '20260825_173608_service_editor_unit_default_on',
]

const applied = (names: string[], batch = 1) => names.map((name) => ({ name, batch }))

describe('verify-migrations — diffLedger()', () => {
  it('passes when every committed migration is recorded and there is no dev marker', () => {
    const res = diffLedger(FILES, applied(FILES))
    expect(res.ok).toBe(true)
    expect(res.problems).toEqual([])
    expect(res.warnings).toEqual([])
    expect(res.devMarker).toBe(false)
    expect(res.missing).toEqual([])
  })

  it('fails on a dev-push marker even when every migration is recorded (the silent no-op case)', () => {
    const rows = [...applied(FILES), { name: 'dev', batch: -1 }]
    const res = diffLedger(FILES, rows)
    expect(res.ok).toBe(false)
    expect(res.devMarker).toBe(true)
    expect(res.problems.join('\n')).toMatch(/dev-push marker/)
  })

  it('treats the batch column as a string too (pg returns numerics as strings)', () => {
    // payload_migrations.batch is `numeric`, so node-postgres hands it back as a string.
    const rows = [...FILES.map((name) => ({ name, batch: '1' })), { name: 'dev', batch: '-1' }]
    const res = diffLedger(FILES, rows)
    expect(res.devMarker).toBe(true)
    expect(res.missing).toEqual([])
  })

  it('fails when a committed migration has no ledger row (the post-apply check)', () => {
    const res = diffLedger(FILES, applied(FILES.slice(0, 2)))
    expect(res.ok).toBe(false)
    expect(res.missing).toEqual(['20260825_173608_service_editor_unit_default_on'])
    expect(res.problems.join('\n')).toMatch(/not recorded as applied/)
  })

  it('--pre ignores missing migrations (they are what `payload migrate` is about to apply) but never the marker', () => {
    expect(diffLedger(FILES, applied(FILES.slice(0, 2)), { pre: true }).ok).toBe(true)
    expect(diffLedger(FILES, [], { pre: true }).ok).toBe(true)
    expect(
      diffLedger(FILES, [...applied(FILES.slice(0, 2)), { name: 'dev', batch: -1 }], { pre: true })
        .ok,
    ).toBe(false)
  })

  it('reproduces the exact staging state found on 2026-09-13 (two applied, one pushed-not-migrated, marker)', () => {
    const rows = [
      { name: '20260707_153821_initial', batch: '1' },
      { name: '20260717_164130_phase2b_slug_service_snapshot', batch: '1' },
      { name: 'dev', batch: '-1' },
    ]
    const res = diffLedger(FILES, rows)
    expect(res.ok).toBe(false)
    expect(res.devMarker).toBe(true)
    expect(res.missing).toEqual(['20260825_173608_service_editor_unit_default_on'])
    expect(res.problems).toHaveLength(2)
  })

  it('only WARNS about a ledger row with no matching file (a renamed/deleted migration)', () => {
    const res = diffLedger(FILES, [...applied(FILES), { name: '20260101_000000_gone', batch: 1 }])
    expect(res.ok).toBe(true)
    expect(res.unknown).toEqual(['20260101_000000_gone'])
    expect(res.warnings.join('\n')).toMatch(/no matching file/)
  })

  it('does not count the dev marker as an "unknown" ledger row', () => {
    const res = diffLedger(FILES, [...applied(FILES), { name: 'dev', batch: -1 }])
    expect(res.unknown).toEqual([])
  })
})

describe('verify-migrations — readMigrationNames()', () => {
  it('lists *.ts/*.js migration files, excluding index.*, sorted, mirroring payload', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bulbau-migrations-'))
    try {
      for (const f of [
        '20260717_164130_b.ts',
        '20260707_153821_a.ts',
        '20260707_153821_a.json',
        'index.ts',
        'index.js',
        'notes.md',
      ]) {
        fs.writeFileSync(path.join(dir, f), '')
      }
      expect(readMigrationNames(dir)).toEqual(['20260707_153821_a', '20260717_164130_b'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('matches the migrations actually committed in src/migrations (and their index.ts registry)', async () => {
    const dir = path.resolve(process.cwd(), 'src/migrations')
    const names = readMigrationNames(dir)
    expect(names.length).toBeGreaterThan(0)
    // Every file the verifier would demand a ledger row for must be registered in
    // index.ts — the list `payload migrate` actually runs. A file that is not
    // registered would make the post-apply check fail forever.
    const { migrations } = await import('../../src/migrations/index')
    expect(names).toEqual(migrations.map((m) => m.name))
  })

  it('returns [] for a missing directory instead of throwing', () => {
    expect(readMigrationNames(path.join(os.tmpdir(), 'does-not-exist-bulbau'))).toEqual([])
  })
})
