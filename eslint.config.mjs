import { includeIgnoreFile } from '@eslint/compat'
import { defineConfig } from 'eslint/config'
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals'
import nextTypescript from 'eslint-config-next/typescript'
import { fileURLToPath } from 'node:url'

// Flat config does NOT read .gitignore automatically (that implicit behavior
// was dropped when ESLint moved off .eslintignore) — without this, every
// build/deploy artifact directory that's gitignored but happens to exist
// locally (.open-next/, .next/, coverage/, etc.) gets linted too, and since
// those are bundled/minified/generated JS, they trip rules like
// no-unused-expressions and no-require-imports thousands of times over. This
// makes .gitignore the single source of truth instead of hand-maintaining a
// second, drifting ignore list — see
// https://eslint.org/docs/latest/use/configure/ignore#include-gitignore-files.
//
// `includeIgnoreFile` comes from `@eslint/compat`, not the `eslint/config`
// re-export: that re-export is an ESLint v10 addition and doesn't exist on
// the v9.x line this project pins (confirmed against the installed
// eslint@9.39.4 — `eslint/config` only exports `defineConfig`/`globalIgnores`
// on v9). `@eslint/compat`'s version of this helper has been stable since
// ESLint 9's initial flat-config-by-default release and works the same way.
const gitignorePath = fileURLToPath(new URL('.gitignore', import.meta.url))

const eslintConfig = defineConfig([
  includeIgnoreFile(gitignorePath, { gitignoreResolution: true }),
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      '@typescript-eslint/ban-ts-comment': 'warn',
      '@typescript-eslint/no-empty-object-type': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          vars: 'all',
          args: 'after-used',
          ignoreRestSiblings: false,
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^(_|ignore)',
        },
      ],
    },
  },
  {
    // Not gitignored (they're committed, generated-but-checked-in files) —
    // still shouldn't be hand-linted, so this stays a separate, explicit list.
    // sst-env.d.ts ships its own blanket `/* eslint-disable */` header (SST's
    // codegen, not ours), which trips `reportUnusedDisableDirectives` on any
    // file where nothing else happens to trigger a rule — excluding it here
    // avoids fighting SST's own generated boilerplate.
    ignores: [
      'src/payload-types.ts',
      'src/payload-generated-schema.ts',
      'sst-env.d.ts',
    ],
  },
])

export default eslintConfig
