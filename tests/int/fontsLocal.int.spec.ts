import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

// The build must not need Google. `next/font/google` downloads the font files
// from Google during every build, and Google refusing that download failed
// three CI builds in a single day (2026-10-29/30), each one blocking a deploy.
// src/lib/fonts.ts loads the same typefaces from the @fontsource packages
// instead. These checks keep it that way: a reintroduced `next/font/google`,
// or a font file renamed by a future @fontsource release, fails here with a
// clear message instead of in a deploy.

const ROOT = process.cwd()

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return /\.(ts|tsx|js|jsx|mjs)$/.test(name) ? [full] : []
  })
}

describe('fonts are built from local files', () => {
  it('nothing in src/ imports next/font/google', () => {
    const offenders = sourceFiles(path.join(ROOT, 'src'))
      // An import or require, not a mention: src/lib/fonts.ts explains the
      // switch in a comment that names the old module.
      .filter((file) =>
        /(from\s*|require\(\s*|import\(\s*)['"]next\/font\/google['"]/.test(
          readFileSync(file, 'utf8'),
        ),
      )
      .map((file) => path.relative(ROOT, file))
    expect(offenders, 'use next/font/local via src/lib/fonts.ts; see its header comment').toEqual(
      [],
    )
  })

  it('every font file src/lib/fonts.ts names exists', () => {
    const fontsModule = path.join(ROOT, 'src/lib/fonts.ts')
    const paths = [...readFileSync(fontsModule, 'utf8').matchAll(/'(\.\.\/[^']+\.woff2)'/g)].map(
      (m) => m[1],
    )
    expect(paths.length).toBe(6) // Inter (variable) + Barlow Condensed 500–900
    for (const p of paths) {
      expect(
        existsSync(path.resolve(path.dirname(fontsModule), p)),
        `missing font file: ${p}`,
      ).toBe(true)
    }
  })
})
