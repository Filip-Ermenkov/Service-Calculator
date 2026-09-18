# bulbau.lu

Multilingual (EN/FR/DE) service-calculator website for a Luxembourg service
business. Next.js (App Router, TypeScript) with Payload CMS 3 embedded in
the same app. `docs/FUNCTIONALITY.md` is the "what", `docs/TECHSPEC.md` the
"how", `docs/PROGRESS.md` the verified current state and next steps — this
README covers day-to-day commands only.

**Status (2026-09-18):** live in production at `https://bulbau.lu` (custom
domain, `www` → apex, manual-approval `deploy-production` job) but **not yet
publicly launched** — search indexing stays off until the launch flip. Staging:
`https://d20kjuz86nwvyp.cloudfront.net`. Latest deployed commit on both stages:
`71561dd` (shared DynamoDB rate limiting + dependency sweep); `c88598c` (media
served by CloudFront straight from S3 at `/media/*`, migration #5) is on
**staging** with production awaiting approval, and the commit carrying these
docs adds five hygiene fixes. Remaining proofs: `docs/PROGRESS.md` →
"Immediate next steps", step 1.

**Every planned feature is built** (TECHSPEC §12, Phases 0–6): the admin panel
with mandatory 2FA and a working password reset, the content model with
per-deploy migrations, the trilingual public site (`/en|/fr|/de`), the
real-time price calculator with the admin formula bar, PDF quotes (download and
email via SES), EN→FR/DE auto-translation with a Translation Management screen,
the `/contact` page with Cloudflare Turnstile, on-demand CloudFront
invalidation, OWASP security headers, failure-visibility alarms, CI axe (WCAG
2.2 AA) + Lighthouse gates. **Phase 7 (hardening + launch) is in progress.**
What is left is external, not development work: the client's published
`LegalInfo`, production content re-entered after the 2026-09-16 database reset,
the `office@bulbau.lu` mailbox in DNS, SES production access — see
`docs/PROGRESS.md` → "Immediate next steps". Web analytics is deliberately out
of scope (cookieless site, no consent banner).

## Requirements

- Node.js 20.9+ (24.x LTS recommended; CI runs on 24)
- npm 10+
- A **Postgres 18** database — Docker Compose (below) or a personal Neon branch
  (`docs/TECHSPEC.md` §10.1). Neon, docker-compose and CI are all on 18; a
  `pgdata` volume created by the earlier `postgres:17-alpine` image will not
  start under 18 — recreate it (`docker compose down -v && docker compose up -d`,
  then re-seed with `ALLOW_CONTENT_SEED=true npm run seed:ci`).

## Local development

```bash
cp .env.example .env
# edit .env: DATABASE_URL, PAYLOAD_SECRET, TOTP_ENCRYPTION_KEY (openssl rand -base64 32)
# and the S3_* vars — media uploads use @payloadcms/storage-s3 (no local-disk
# option, Lambda has none either): either a real bucket, or the S3Mock container
# below with S3_ENDPOINT pointed at it (no AWS credentials needed).

docker compose up -d      # Postgres + S3Mock
npm install               # also runs `sst install` (postinstall) — needs network, no AWS creds
npm run dev
```

`http://localhost:3000` redirects to the locale-prefixed site (`/en`, `/fr`,
`/de`); the admin panel is `http://localhost:3000/admin` (not localized). On a
fresh database, create the first admin there. Public pages show empty states
until content exists.

Rules that bite:

- **`DATABASE_URL` must be a local database.** In dev/test mode Payload runs in
  schema-*push* mode, and since 2026-09-16 the app **refuses to start** against
  any non-local URL (`src/lib/dbGuard.ts`) — a dev server pointed at staging
  once silently disabled every staging migration for six weeks. Stage-targeted
  commands take the URL on the command line (see "Database migrations"). A
  running dev server keeps the connection it started with.
- **2FA is mandatory.** The first login redirects to `/admin/totp-setup` (scan
  the QR with any authenticator app); every later login needs the 6-digit code
  at `/admin/totp-verify`. Design: `docs/TECHSPEC.md` §6.6/§7.
- **Forgot password** (`/admin/forgot`) works locally without SES: with
  `EMAIL_SENDER` unset the adapter prints the email — link included — to the
  dev-server terminal. Links are built from `NEXT_PUBLIC_SITE_URL` /
  `http://localhost:3000`, never from the request's Host header.
- **After changing a collection, field, global, or a plugin that contributes
  admin UI**, run `npm run generate:types` and `npm run generate:importmap` and
  commit the results. `src/app/(payload)/admin/importMap.js` is generated; a
  stale copy breaks the admin at runtime with no build error. CI fails on any
  drift.
- **Never `npx sst deploy` from a native Windows shell.** OpenNext's build uses
  symlinks that do not survive Windows packaging; the deploy "succeeds" with
  files missing. Deploys go through CI (Ubuntu); a local build test belongs in
  WSL2.
- `AGENTS.md` / `CLAUDE.md` at the repo root are rewritten by `next dev` (Next
  16.3's agent notice) and are gitignored — tool output, not project docs.
- Rate limiting needs nothing locally: with `RATE_LIMIT_TABLE` unset the limiter
  is an exact in-memory sliding log (one process). Deployed stages get a shared
  DynamoDB table from `sst.config.ts` automatically — never set the variable by
  hand.
- **Media URLs are `/media/<file>` on every stage** — the URL path is the S3
  key (`src/lib/media/publicUrl.ts`). Live, CloudFront serves them straight from
  the bucket; locally, the `S3_ENDPOINT` in `.env` also switches on a
  `next.config.ts` rewrite that proxies `/media/*` to S3Mock, so uploads render
  on the dev server too. Payload's old `/api/media/file/<file>` route is off.

## Testing

```bash
npx playwright install chromium   # once per Playwright version
npm run lint          # ESLint (0 errors expected; ~19 known warnings)
npm run typecheck     # tsc --noEmit
npm run test:int      # Vitest — integration tests against DATABASE_URL (Postgres + S3Mock must be up)
npm run test:e2e      # Playwright — boots `next dev` itself; add --workers=1 for CI-identical, race-free runs
npm run test          # both
```

- `npm run test:int` includes a real S3 upload/delete round-trip against the
  S3Mock container (`tests/int/media.int.spec.ts`).
- `npm run test:e2e` includes the **axe-core WCAG 2.2 AA gate**. It neutralises
  CSS animation before scanning (`tests/e2e/accessibility.e2e.spec.ts`) — do not
  "simplify" that away; without it the scan samples colours mid-fade and becomes
  non-deterministic.
- The TOTP, contact and forgot-password limiters are in-memory on a dev server,
  so a second e2e run inside their windows can 429; the forgot-password and
  quote cases use unique buckets per run, TOTP/contact do not. Playwright's
  default local parallelism can race the dev server (each seeding worker boots
  Payload's schema push) — `--workers=1` is deterministic and what CI uses.
- Lighthouse (`npm run lhci`) cannot complete on Windows (chrome-launcher
  `EPERM` teardown); Linux CI is the authority.

**Media limits.** `Media` accepts JPEG/PNG/WebP up to **4 MB** — one constant,
`MEDIA_MAX_FILE_BYTES` in `src/collections/Media.ts`, enforced on the multipart
path, the direct-to-S3 presigned-URL path and by a `beforeValidate` hook. It
used to be a correctness limit (media went through the *buffered* Web Lambda,
6 MB cap after base64); since media is served by CloudFront from S3 it is a
page-weight guard until `next/image` resizes uploads. Details:
`docs/TECHSPEC.md` §6.2.

**Health endpoint.** `GET /api/health` returns `200 {"status":"ok",…}` (or
`503 "degraded"` when a required runtime secret is missing), `Cache-Control:
no-store`. It deliberately does **not** query the database — a 30-second uptime
probe would keep Neon awake and defeat scale-to-zero. Database faults surface
through `OPS_ALERT` log lines → a CloudWatch alarm (`docs/TECHSPEC.md` §8.1).

**Seeding a sample service** (the `/services/[slug]` template 404s on an empty
database, so CI seeds one before its audits):

```bash
ALLOW_CONTENT_SEED=true npm run seed:ci   # idempotent; writes to your .env DATABASE_URL
```

`ALLOW_CONTENT_SEED=true` is a required opt-in so the seed can never hit a real
database by accident. Run it locally only if you want
`/en/services/ci-sample-service` for `npm run test:e2e` / `npm run lhci`.

## Database migrations

Payload/Drizzle **push** mode (schema auto-synced on boot) is ON in local dev
and CI tests and OFF on deployed stages (`NODE_ENV=production`), which change
schema **only** through the tracked migrations in `src/migrations/`
(`docs/TECHSPEC.md` §10.5).

```bash
# 1. Build the feature in dev (push keeps the local DB in sync).
# 2. When the schema is settled, generate a migration and review the SQL:
npm run migrate:create my_change      # writes src/migrations/<ts>_my_change.{ts,json}
# 3. Commit the generated files. CI applies them to staging before deploying.

npm run migrate:status                # which migrations have/haven't run
npm run migrate                       # apply pending migrations to DATABASE_URL
npm run migrate:verify -- --pre       # fail-closed pre-flight: refuses a dev-push marker
npm run migrate:verify                # post-check: every committed migration is recorded as applied
```

Against a deployed stage, pass the **direct (unpooled)** Neon URL explicitly —
DDL breaks through the `-pooler` host — and never by editing `.env`:

```bash
npx cross-env DATABASE_URL="<stage DIRECT url>" npm run migrate:verify -- --pre
npx cross-env NODE_ENV=production DATABASE_URL="<stage DIRECT url>" npm run migrate   # only if not letting CI do it
```

CI runs `migrate:verify -- --pre` → `timeout 600s npm run migrate </dev/null` →
`migrate:verify` on both deploy jobs, fail-closed: `payload migrate` is
interactive and, on a database carrying Payload's dev-push marker, prompts and
exits **0 having applied nothing**. The `verify` job also fails on schema drift
(`migrate:create --skip-empty` writes a file) and generated-artifact drift
(`payload-types.ts` / `importMap.js`).

## Deploying

Infrastructure is `sst.config.ts` (SST v4 / Ion), deployed by
`.github/workflows/ci.yml`: a push to `main` runs `verify`, migrates + deploys
**staging**, then waits for manual approval on the `production` GitHub
Environment before migrating + deploying **production** (`sst deploy --stage
production`). Only production has the custom domain (`bulbau.lu`, wired via a
stage-conditional `domain` block that *looks up* the Terraform-managed Route 53
zone). Foundational, long-lived resources — the hosted zone + reusable
delegation set, the Neon project, the deploy IAM role, budgets, SNS, SES, uptime
monitoring — live in `infra/terraform/` (see its README), deliberately outside
SST so a stage teardown can never destroy DNS or the database.

Per-stage alarms (Lambda errors/throttles, the `OPS_ALERT` metric alarm) are in
`sst.config.ts`, wired by reference. Account-level SNS/Budgets and the us-east-1
uptime + CloudFront alarms stay in Terraform. After an alarm change: deploy SST
first, then `terraform apply`.

The app runs alone in AWS account `847321857537` (`service-calculator-production`);
both GitHub Environments' `AWS_DEPLOY_ROLE_ARN` point at its Terraform-managed
`gh-actions-bulbau-staging-deploy` role (`infra/aws/README.md`). The CI audit
gate is `npm audit --omit=dev --audit-level=high` (the code that ships); a
full-tree audit runs non-blocking.

### Secrets (SST, per stage)

```bash
# Required before the first deploy of a stage
npx sst secret set DatabaseUrl   "postgresql://...-pooler..." --stage staging   # POOLED (runtime)
npx sst secret set PayloadSecret "$(openssl rand -base64 32)"  --stage staging
npx sst secret set TotpEncryptionKey "$(openssl rand -base64 32)" --stage staging  # 2FA + rate-limit key derivation
# The stage's own origin — Payload's serverURL (reset links, the cookie CSRF allowlist),
# canonical/hreflang/OG URLs, the authenticator label. Production falls back to
# https://bulbau.lu if unset; staging has no safe fallback.
npx sst secret set SiteUrl "https://d20kjuz86nwvyp.cloudfront.net" --stage staging
npx sst secret set SiteUrl "https://bulbau.lu"                    --stage production
# Email (SES) — the verified From address for quote emails, the contact-form relay
# and the admin password reset. Unset ⇒ every send is a no-op.
npx sst secret set EmailSender "info@bulbau.lu" --stage staging
# Cloudflare Turnstile (contact form + email-quote); unset ⇒ no-op.
npx sst secret set TurnstileSecretKey "<secret key>" --stage staging
npx sst secret set TurnstileSiteKey   "<site key>"   --stage staging   # NEXT_PUBLIC_* ⇒ inlined at build, so redeploy
# Launch only:
# npx sst secret set AllowIndexing "true" --stage production
```

Things that need **no** secret because they ride the Lambda execution role:
**rate limiting** (a per-stage DynamoDB table, `RATE_LIMIT_TABLE`), **CMS
auto-translation** (AWS Translate, `TRANSLATE_ENABLED='true'` on every deployed
stage), **on-demand CloudFront invalidation** (the distribution id is written to
SSM after deploy and read at runtime), **SES sending** (the identity is
Terraform-managed) and **S3 media** (uploads via the role; delivery via a
CloudFront origin access control on the same distribution — no key, no public
bucket).

GitHub **Environment** secrets (repo settings): on `staging` —
`AWS_DEPLOY_ROLE_ARN` (OIDC deploy role) and `STAGING_DATABASE_URL_UNPOOLED`
(the direct Neon URL for the migrate step and build-time static generation); on
`production` — the same `AWS_DEPLOY_ROLE_ARN` and `PRODUCTION_DATABASE_URL_UNPOOLED`,
plus a **Required reviewers** protection rule (what pauses the production job).

## Project structure

`docs/TECHSPEC.md` §4 has the full layout. Quick pointers:

- `src/app/[locale]/` — the public site (localized root layout, pages,
  `globals.css`); i18n in `src/i18n/`; `src/proxy.ts` composes next-intl's
  routing with the TOTP admin gate; data access is `src/lib/content.ts`.
- `src/app/(payload)/` — Payload's admin UI + REST API (`/admin`, `/api`);
  `admin/importMap.js` is generated. GraphQL is disabled.
- `src/app/(frontend)/` — only the bare `/ → /<locale>` redirect.
- `src/lib/` — pricing engine, PDF, email (SES), translation, rate limiting,
  observability, security headers (+ their CloudFront projection for `/media/*`),
  media URL contract (`media/publicUrl.ts`), TOTP.
- `prototype/` — the static, client-approved design reference.
- `infra/aws/` — the deploy role's trust + permission JSON (Terraform-managed);
  `infra/terraform/` — the foundational stack; `sst.config.ts` at the root — the
  per-stage app stack (the SST CLI requires that location).
- `docs/PROGRESS.md` — verified current state, next steps, and the slice log —
  read it first when picking the project back up.
