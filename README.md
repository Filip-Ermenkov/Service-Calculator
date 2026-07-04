# bulbau.lu

Multilingual (EN/FR/DE) service-calculator website for a Luxembourg service
business. Next.js (App Router, TypeScript) with Payload CMS 3 embedded in
the same app. See `docs/FUNCTIONALITY.md` (the "what") and
`docs/TECHSPEC.md` (the "how") for the full spec — this README only covers
day-to-day commands.

## Requirements

- Node.js 20.9+ (24.x LTS recommended; CI runs on 24)
- npm 10+
- A Postgres database — either Docker Compose (below) or a personal Neon
  branch (recommended, see `docs/TECHSPEC.md` §10.1)

## Local development

```bash
cp .env.example .env
# then edit .env: set DATABASE_URL and PAYLOAD_SECRET
# generate a secret with: openssl rand -base64 32
# also set S3_BUCKET — media uploads use @payloadcms/storage-s3 (no local-disk
# fallback works on Lambda, so there's no local-disk option here either); point
# it at any bucket you can reach, or a personal/dev bucket

# Option A — local Postgres via Docker:
docker compose up -d

# Option B — point DATABASE_URL at a personal Neon branch instead
# (use the POOLED connection string, hostname contains "-pooler")

npm install
npm run dev
```

`npm install` also runs `sst install` automatically (a `postinstall` hook) —
this downloads the SST/Pulumi AWS provider and generates
`.sst/platform/config.d.ts`, which `sst.config.ts` needs for its types. It
needs network access but no AWS credentials. If you ever see TypeScript
errors pointing at `sst.config.ts` (`Cannot find name '$config'`, etc.), it
means that hook didn't run — just run `npx sst install` once by hand.

Visit `http://localhost:3000` for the public site placeholder, and
`http://localhost:3000/admin` to create the first admin user.

**If you change a collection, a field, or a plugin that contributes admin
UI** (like `@payloadcms/storage-s3`'s upload handler), run
`npm run generate:importmap` afterwards. Payload's admin route resolves
custom components through `src/app/(payload)/admin/importMap.js`, which is
generated, not hand-written — it goes stale silently (no build error, just a
broken admin page at runtime) if you skip this.

**Do not run `npx sst deploy` from a native Windows shell.** OpenNext's
build copies externalized packages into the Lambda bundle via symlinks,
and a Windows-created symlink doesn't survive being packaged the way a
Linux one does — the build succeeds but the deployed function is missing
files. Deploys go through CI (`ubuntu-latest`) for exactly this reason; if
you need to test a build locally, do it from WSL2, not PowerShell/CMD.

## Testing

The first time you run the Playwright suite, install its browser binary
(one-time, not needed again after):

```bash
npx playwright install chromium
```

```bash
npm run lint         # ESLint
npm run typecheck    # tsc --noEmit
npm run test:int     # Vitest — integration tests against DATABASE_URL
npm run test:e2e     # Playwright — needs `npm run build && npm start` or `next dev` running
npm run test         # both of the above
```

## Deploying

Infrastructure is defined in `sst.config.ts` (SST v4 / Ion engine) and
deployed via GitHub Actions (`.github/workflows/ci.yml`) — pushes to `main`
deploy to the `staging` stage automatically after tests pass. There is no
production deploy job yet (added once staging has been verified stable).

Secrets are never stored in this repo or in GitHub Actions secrets directly
for app-level config — they're SST secrets, scoped per stage:

```bash
npx sst secret set DatabaseUrl "postgresql://...-pooler..." --stage staging
npx sst secret set PayloadSecret "$(openssl rand -base64 32)" --stage staging
```

The GitHub Actions AWS credentials themselves use OIDC federation (a
short-lived assumed role, not a stored access key) — see the repo's GitHub
Environment settings for the `AWS_DEPLOY_ROLE_ARN` secret (an IAM role ARN,
not a credential) and `docs/TECHSPEC.md` §10 for the trust policy.

## Project structure

See `docs/TECHSPEC.md` §4 for the full layout and reasoning. Quick pointers:

- `src/app/(payload)/` and `src/app/(frontend)/` follow Payload's own
  official route-group convention — the `(payload)` files (including
  `admin/importMap.js`) are generated and must not be hand-edited.
- `prototype/` is the static, client-approved design reference (zero
  backend logic) — not to be confused with the real frontend above.
- `infra/aws/` holds the one-time IAM bootstrap for GitHub Actions OIDC —
  see its own README. Everything else AWS-related lives in `sst.config.ts`
  at the repo root (not `infra/` — the SST CLI requires this).
- `docs/PROGRESS.md` is the rolling build/debug log and current handoff
  state — read this first if you're picking the project back up.
