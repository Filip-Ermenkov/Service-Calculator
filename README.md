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
# then edit .env: set DATABASE_URL, PAYLOAD_SECRET, and TOTP_ENCRYPTION_KEY
# generate secrets with: openssl rand -base64 32
# also set the S3_* vars — media uploads use @payloadcms/storage-s3 (no
# local-disk fallback works on Lambda, so there's no local-disk option here
# either). Two options, both documented in .env.example:
#   A) point S3_BUCKET/AWS_REGION at a real bucket you can reach
#   B) run the S3Mock container below and point S3_ENDPOINT at it instead —
#      no real AWS credentials needed for local dev

# Local Postgres + S3Mock via Docker:
docker compose up -d

# Postgres alternative — point DATABASE_URL at a personal Neon branch instead
# (use the POOLED connection string, hostname contains "-pooler"); S3Mock has
# no such hosted alternative, always run it locally for dev/test.

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

**Two-factor authentication is mandatory, not optional** (`docs/FUNCTIONALITY.md`
§5.1): the first time you log in, you're redirected to `/admin/totp-setup` to
scan a QR code with an authenticator app (Google Authenticator, Authy,
Microsoft Authenticator, 1Password, etc.) before you can reach anything else
in the admin panel. Every login after that requires the current 6-digit
code at `/admin/totp-verify`. See `docs/TECHSPEC.md` §6.6 and §7 for the
design (custom TOTP endpoints + a step-up cookie layered on top of
Payload's own password auth, since Payload doesn't ship 2FA natively) and
rate-limiting/lockout notes.

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

`npm run test:int` includes a real (mocked) S3 upload/delete round-trip
(`tests/int/media.int.spec.ts`) against the S3Mock container from
`docker compose up -d` — make sure it's running (`docker compose ps`) before
running tests locally, same as Postgres.

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

## Database migrations

Payload/Drizzle **push** mode (schema auto-synced on boot) is ON in local dev
and CI tests, and OFF on deployed stages (`NODE_ENV=production`). So the dev DB
and the ephemeral CI Postgres never need a migration run — but deployed stages
(Lambda) change schema **only** through tracked migrations in `src/migrations/`.
See `docs/TECHSPEC.md` §10.5 and `docs/PROGRESS.md` for the full rationale.

Workflow when you change a collection, field, or global:

```bash
# 1. Build the feature in dev (push keeps your local DB in sync as you go).
# 2. When the schema is settled, generate a migration and review the SQL:
npm run migrate:create my_change      # writes src/migrations/<ts>_my_change.{ts,json}
# 3. Commit the generated files. CI applies them to staging before deploying.

npm run migrate:status                # which migrations have/haven't run
npm run migrate                       # apply pending migrations to DATABASE_URL
```

**Neon note:** run migrations against the **direct (unpooled)** connection
string — the one **without** `-pooler` in the hostname. DDL breaks through
Neon's PgBouncer pooler (transaction pooling). The app's *runtime* `DATABASE_URL`
stays the pooled URL; only migrations use the direct one. CI does this for you
(the `STAGING_DATABASE_URL_UNPOOLED` Environment secret, below).

## Deploying

Infrastructure is defined in `sst.config.ts` (SST v4 / Ion engine) and
deployed via GitHub Actions (`.github/workflows/ci.yml`) — pushes to `main`
deploy to the `staging` stage automatically after tests pass. The deploy job
runs `npm run migrate` against staging **before** `sst deploy`, so the schema
is always at least as new as the code. There is no production deploy job yet
(added once staging has been verified stable).

Secrets are never stored in this repo or in GitHub Actions secrets directly
for app-level config — they're SST secrets, scoped per stage. All four of the
first block are required before the first deploy; the Upstash pair is optional
(unset ⇒ in-memory rate-limit fallback, fine pre-launch):

```bash
npx sst secret set DatabaseUrl   "postgresql://...-pooler..." --stage staging   # POOLED (runtime)
npx sst secret set PayloadSecret "$(openssl rand -base64 32)"  --stage staging
npx sst secret set TotpEncryptionKey "$(openssl rand -base64 32)" --stage staging  # required — 2FA breaks without it
# Optional (recommended before production):
npx sst secret set UpstashRedisRestUrl   "https://xxx.upstash.io" --stage staging
npx sst secret set UpstashRedisRestToken "your-upstash-token"     --stage staging
```

Two GitHub **Environment** (`staging`) secrets are also needed, set in the repo
settings (not via SST):

- `AWS_DEPLOY_ROLE_ARN` — the OIDC deploy role (short-lived assumed role, not a
  stored access key); see `docs/TECHSPEC.md` §10 for the trust policy.
- `STAGING_DATABASE_URL_UNPOOLED` — the **direct** Neon URL used by the CI
  migrate step (see "Database migrations" above).

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
