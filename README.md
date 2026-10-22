# bulbau.lu

Multilingual (EN/FR/DE) service-calculator website for a Luxembourg service
business. Next.js (App Router, TypeScript) with Payload CMS 3 embedded in the
same app, deployed to AWS Lambda via OpenNext/SST.

- `docs/FUNCTIONALITY.md` — what it does
- `docs/TECHSPEC.md` — how it is built
- `docs/PROGRESS.md` — current state and what is left **(read this first)**
- this README — commands

**Live in production at `https://bulbau.lu`, not yet publicly launched:**
search indexing stays off until the launch flip. Staging is
`https://d20kjuz86nwvyp.cloudfront.net`.

## Requirements

- Node.js 24.x LTS (CI runs 24)
- npm 10+
- **Postgres 18** — Docker Compose below, or a personal Neon branch. A `pgdata`
  volume created by an older major will not start under 18; recreate it with
  `docker compose down -v && docker compose up -d`.

## Local development

```bash
cp .env.example .env
# Set DATABASE_URL, PAYLOAD_SECRET, TOTP_ENCRYPTION_KEY (openssl rand -base64 32)
# and the S3_* vars. Media uploads always go through S3 (no local-disk option —
# Lambda has none either): use the S3Mock container below, no AWS creds needed.

docker compose up -d      # Postgres + S3Mock
npm install               # postinstall runs `sst install` — needs network, no AWS creds
npm run dev
```

`http://localhost:3000` redirects to `/en`. The admin is `/admin` (not
localized); create the first user there on a fresh database. Public pages show
empty states until content exists.

### Rules that bite

- **`DATABASE_URL` must be local.** In dev/test Payload runs in schema-*push*
  mode, and the app **refuses to start** against a non-local URL
  (`src/lib/dbGuard.ts`). A dev server once pointed at staging silently disabled
  every staging migration for six weeks. Stage-targeted commands take the URL on
  the command line instead.
- **2FA is mandatory.** First login redirects to `/admin/totp-setup`. **Save the
  secret, not just the QR** — if a user loses their authenticator, only another
  admin can reset it (`/api/users/totp/admin-reset`, exposed on the user's edit
  screen).
- **Forgot password works locally without SES** — with `EMAIL_SENDER` unset the
  adapter prints the email, link included, to the dev-server terminal.
- **After changing a collection, field, global, or admin component**, run
  `npm run generate:types` and `npm run generate:importmap` and commit the
  result. A stale `importMap.js` breaks the admin at runtime with no build
  error. CI fails on any drift.
- **Never `npx sst deploy` from Windows.** OpenNext's symlinks do not survive
  Windows packaging; the deploy "succeeds" with files missing. Deploys go
  through CI.
- **Media URLs are `/media/<key>` on every stage** — the URL path *is* the S3
  key (`src/lib/media/publicUrl.ts`). Live, CloudFront serves them straight from
  the bucket; locally, setting `S3_ENDPOINT` switches on a `next.config.ts`
  rewrite to S3Mock so the same URLs resolve. Payload's `/api/media/file/*`
  route is off.
- **Rate limiting needs nothing locally.** With `RATE_LIMIT_TABLE` unset the
  limiter is an in-memory sliding log. Deployed stages get a DynamoDB table
  automatically — never set the variable by hand.
- `AGENTS.md` / `CLAUDE.md` are rewritten by `next dev` and gitignored — tool
  output, not project docs.

## Testing

```bash
npx playwright install chromium   # once per Playwright version
npm run lint          # 0 errors expected (~24 known warnings in migrations)
npm run typecheck
npm run test:int      # Vitest — needs Postgres + S3Mock up
npm run test:e2e      # Playwright — boots `next dev` itself
npm run audit:prod    # the CI dependency gate
npm run test          # int + e2e
```

- `test:e2e` includes the **axe-core WCAG 2.2 AA gate**. It neutralises CSS
  animation before scanning — do not remove that; without it the scan samples
  colours mid-fade and becomes non-deterministic.
- Use `--workers=1` locally. Each seeding worker boots Payload's schema push
  against one database, so default parallelism races the dev server. CI uses 1.
- The TOTP and contact limiters are in-memory on a dev server, so a second e2e
  run inside their windows can 429.
- `npm run lhci` cannot complete on Windows (chrome-launcher `EPERM`). Linux CI
  is the authority.
- S3Mock is **in-memory**: restarting the container loses uploaded objects and
  the media e2e test will 404. Re-run `npm run seed:ci`.

**Seeding** (the `/services/[slug]` template 404s on an empty database, so CI
seeds one before its audits):

```bash
ALLOW_CONTENT_SEED=true npm run seed:ci   # idempotent
```

The opt-in flag exists so the seed can never hit a real database by accident.

## Database migrations

Push mode (schema auto-synced on boot) is ON locally and in CI tests, OFF on
deployed stages — those change schema **only** through `src/migrations/`.

```bash
npm run migrate:create my_change   # after the schema settles; commit the .ts + .json
npm run migrate:status
npm run migrate                    # apply pending to DATABASE_URL
npm run migrate:verify -- --pre    # fail-closed pre-flight: refuses a dev-push marker
npm run migrate:verify             # post-check: every committed migration is applied
```

Against a deployed stage pass the **direct (unpooled)** Neon URL on the command
line — DDL breaks through the `-pooler` host, and never edit `.env`:

```bash
npx cross-env DATABASE_URL="<stage DIRECT url>" npm run migrate:verify -- --pre
```

CI brackets the apply with `migrate:verify --pre` → `migrate` → `migrate:verify`
on both deploy jobs. This is fail-closed on purpose: `payload migrate` is
interactive and, against a database carrying Payload's dev-push marker, prompts
and exits **0 having applied nothing**.

## Deploying

`sst.config.ts` (SST v4) + `.github/workflows/ci.yml`. A push to `main` runs
`verify`, then migrates and deploys **staging**, then waits for manual approval
on the `production` GitHub Environment before doing the same for production.
Only production has the custom domain.

Foundational, long-lived resources — the Route 53 zone, the Neon project, the
deploy IAM role, budgets, SNS, SES, uptime monitoring — live in
`infra/terraform/` (see its README), deliberately outside SST so a stage
teardown can never destroy DNS or the database. Per-stage alarms are in
`sst.config.ts`. After an alarm change: deploy SST first, then `terraform apply`.

The app runs alone in AWS account `847321857537`.

### CI gates

Beyond lint/typecheck/tests: a **dependency audit** that fails on any
unaccepted high/critical advisory in the production tree
(`scripts/audit-production-deps.mjs` — exceptions need written evidence and a
review date), **schema and generated-artifact drift** guards, **axe** and
**Lighthouse** budgets, Terraform `fmt`/`validate`/`test`, and a **post-deploy
image smoke test** that proves `next/image` really optimizes on the deployed
stage (`scripts/smoke-image-optimizer.mjs`) — nothing else can, because every
other test runs against `next start`.

### Secrets (SST, per stage)

```bash
npx sst secret set DatabaseUrl   "postgresql://...-pooler..." --stage staging   # POOLED
npx sst secret set PayloadSecret "$(openssl rand -base64 32)"  --stage staging
npx sst secret set TotpEncryptionKey "$(openssl rand -base64 32)" --stage staging
npx sst secret set SiteUrl "https://d20kjuz86nwvyp.cloudfront.net" --stage staging
npx sst secret set EmailSender "info@bulbau.lu" --stage staging
npx sst secret set TurnstileSecretKey "<secret>" --stage staging
npx sst secret set TurnstileSiteKey   "<site>"   --stage staging   # NEXT_PUBLIC_* ⇒ inlined at build, so redeploy
# Launch only:
# npx sst secret set AllowIndexing "true" --stage production
```

`SiteUrl` is the stage's own origin: Payload's `serverURL` (reset links, the
cookie CSRF allowlist), canonical/hreflang/OG URLs, and the authenticator
label. Production falls back to `https://bulbau.lu`; staging has no safe
fallback, so it must be set.

Needing **no** secret because they ride the Lambda execution role: rate limiting
(DynamoDB), CMS auto-translation (AWS Translate), CloudFront invalidation, SES
sending, and S3 media.

**GitHub Environment secrets:** both environments have `AWS_DEPLOY_ROLE_ARN`
(OIDC); `staging` has `STAGING_DATABASE_URL_UNPOOLED` and `production` has
`PRODUCTION_DATABASE_URL_UNPOOLED` (the direct Neon URLs, used by the migrate
step and build-time static generation). `production` also has a required
reviewer — that is what pauses the deploy.

## Project structure

`docs/TECHSPEC.md` §4 has the full layout.

- `src/app/[locale]/` — the public site; i18n in `src/i18n/`; data access in
  `src/lib/content.ts`
- `src/app/(payload)/` — Payload's admin UI + REST API. GraphQL is disabled.
- `src/proxy.ts` — composes next-intl routing with the TOTP admin gate
- `src/lib/` — pricing, PDF, email (SES), translation, rate limiting,
  observability, security headers, the media URL contract, TOTP
- `infra/terraform/` — the foundational stack; `sst.config.ts` — the per-stage
  app stack (the SST CLI requires it at the root)
- `prototype/` — the static, client-approved design reference
