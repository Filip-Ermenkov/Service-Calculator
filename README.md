# bulbau.lu

Multilingual (EN/FR/DE) service-calculator website for a Luxembourg service
business. Next.js (App Router, TypeScript) with Payload CMS 3 embedded in
the same app. See `docs/FUNCTIONALITY.md` (the "what") and
`docs/TECHSPEC.md` (the "how") for the full spec — this README only covers
day-to-day commands.

**Status (2026-09-17):** live in production at `https://bulbau.lu` (custom domain, `www` → apex, manual-approval `deploy-production` job) but **not yet publicly launched** — search indexing stays off until the launch flip. Staging: `https://d20kjuz86nwvyp.cloudfront.net`.

**Every planned feature is built** (TECHSPEC §12, Phases 0–6): the admin panel with mandatory 2FA and a working password reset, the content model with per-deploy migrations, the trilingual public site (`/en|/fr|/de`), the real-time price calculator with the admin **formula bar**, PDF quotes (download and email via SES), EN→FR/DE auto-translation with a Translation Management screen, the `/contact` page with Cloudflare Turnstile, on-demand CloudFront invalidation, OWASP security headers, failure-visibility alarms, and CI axe (WCAG 2.2 AA) + Lighthouse gates. **Phase 7 (hardening + launch) is in progress**; `docs/PROGRESS.md` → "Current state" / "Immediate next steps" is the source of truth for what is left.

**Both databases were reset from empty on 2026-09-16** and rebuilt by CI from the four committed migrations — production content has to be re-entered. Remaining launch blockers are external, not development work: the client's published `LegalInfo` details, the `office@bulbau.lu` mailbox in DNS (then verified as the contact-form destination), and SES production access for the email-quote path. Web analytics was evaluated and **deliberately left out of scope** — the site stays cookieless with no consent banner.

Visit `http://localhost:3000` (redirects to `/en`); the admin panel stays at `/admin` (unlocalized). **`docs/PROGRESS.md` is the source of truth for progress and next steps.**


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

# Postgres alternative — point DATABASE_URL at a PERSONAL Neon dev branch instead
# (its DIRECT/unpooled URL — local dev pushes schema, and DDL breaks through the
# PgBouncer pooler). NEVER a stage's branch: since 2026-09-16 the app REFUSES TO
# START in dev/test mode against any non-local DATABASE_URL (src/lib/dbGuard.ts),
# because a dev server pointed at staging silently disabled every staging
# migration for six weeks. S3Mock has no hosted alternative — always run it locally.

npm install
npm run dev
```

`npm install` also runs `sst install` automatically (a `postinstall` hook) —
this downloads the SST/Pulumi AWS provider and generates
`.sst/platform/config.d.ts`, which `sst.config.ts` needs for its types. It
needs network access but no AWS credentials. If you ever see TypeScript
errors pointing at `sst.config.ts` (`Cannot find name '$config'`, etc.), it
means that hook didn't run — just run `npx sst install` once by hand.

Visit `http://localhost:3000` — it redirects to the locale-prefixed public
site (`/en`, `/fr`, or `/de` per your browser). The admin panel is at
`http://localhost:3000/admin` (unlocalized); on a fresh database, go there to
create the first admin user. Public pages read from the CMS, so they show
empty states until you add content in the admin.

**Two-factor authentication is mandatory, not optional** (`docs/FUNCTIONALITY.md`
§5.1): the first time you log in, you're redirected to `/admin/totp-setup` to
scan a QR code with an authenticator app (Google Authenticator, Authy,
Microsoft Authenticator, 1Password, etc.) before you can reach anything else
in the admin panel. Every login after that requires the current 6-digit
code at `/admin/totp-verify`. See `docs/TECHSPEC.md` §6.6 and §7 for the
design (custom TOTP endpoints + a step-up cookie layered on top of
Payload's own password auth, since Payload doesn't ship 2FA natively) and
rate-limiting/lockout notes.

**Forgot password** (`/admin/forgot`) emails a single-use, one-hour reset link
through the same SES path as the site's other mail (`src/lib/email/payloadEmailAdapter.ts`).
Locally `EMAIL_SENDER` is unset, so the adapter **prints the email — link included —
to the dev-server terminal** instead of sending; copy the link to complete the flow.
The link is built from Payload's `serverURL` (`src/lib/serverUrl.ts` — `http://localhost:3000`
locally, the `SiteUrl` secret on a stage), never from the request's Host header, and
that same origin is the only one Payload accepts the admin session cookie from.

**If you change a collection, a field, or a plugin that contributes admin
UI** (like `@payloadcms/storage-s3`'s upload handler), run
`npm run generate:importmap` afterwards (and `npm run generate:types` when
you change any collection/field/global). Payload's admin route resolves
custom components through `src/app/(payload)/admin/importMap.js`, which is
generated, not hand-written — it goes stale silently (no build error, just a
broken admin page at runtime) if you skip this. **CI enforces this:** the
`verify` job regenerates `payload-types.ts` + `importMap.js` and fails on any
diff, so a stale copy of either can't reach a deploy (details: §10.5).

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
npm run lint         # ESLint (0 errors expected; ~15 known warnings)
npm run typecheck    # tsc --noEmit
npm run test:int     # Vitest — integration tests against DATABASE_URL
npm run test:e2e     # Playwright — needs `npm run build && npm start` or `next dev` running
npm run test         # both of the above
```

`npm run test:e2e` also runs the **axe-core WCAG 2.2 AA gate**. That gate neutralises CSS
animation before scanning (`tests/e2e/accessibility.e2e.spec.ts`) — do not "simplify" that
away: without it the scan samples colours mid-fade and the result is non-deterministic,
which is how a passing build and a failing build could differ by nothing but render timing.

### Health endpoint

`GET /api/health` returns `200 {"status":"ok",...}` (or `503 "degraded"` when a required
runtime secret is missing), with `Cache-Control: no-store`. It is the target of the optional
Route 53 uptime check in `infra/terraform/uptime.tf`.

It **deliberately does not query the database**. A deep check sounds better but would defeat
Neon's scale-to-zero — an uptime probe every 30s would keep the database awake permanently
and blow the free tier. Database faults are surfaced a different way: every resilient read in
`src/lib/content.ts` emits an `OPS_ALERT` line, which a CloudWatch metric filter turns into an
alarm (see `docs/TECHSPEC.md` §8.1).

### Seeding sample content for the `/services/[slug]` audits

The service-detail page (the live calculator + Download-PDF button) is the core
interactive surface, but it 404s on an empty database — so CI could not audit it
with axe/Lighthouse and the calculator/quote e2e tests could only skip. The
`verify` job now seeds one published sample service before building, so all three
cover it. That seed is:

```bash
ALLOW_CONTENT_SEED=true npm run seed:ci   # idempotent; writes to your .env DATABASE_URL
```

`ALLOW_CONTENT_SEED=true` is a required opt-in guard so the seed can never write
to a real (staging/prod) database by accident; without it the script refuses to
run. It's idempotent (delete-then-create on a fixed slug, `ci-sample-service`).
Run it locally only if you want the seeded page (`/en/services/ci-sample-service`)
present for a local `npm run test:e2e` / `npm run lhci`; delete the "CI Sample
Service" in the admin afterward if you don't want it in your dev DB. In CI the
database is ephemeral, so nothing persists.

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
npm run migrate:verify -- --pre       # fail-closed pre-flight: refuses a dev-push marker
npm run migrate:verify                # post-check: every committed migration is recorded as applied
```

**Against a deployed stage, pass the URL explicitly — never by editing `.env`:**

```bash
npx cross-env DATABASE_URL="<stage DIRECT url>" npm run migrate:verify -- --pre
npx cross-env NODE_ENV=production DATABASE_URL="<stage DIRECT url>" npm run migrate   # only if not letting CI do it
```

`NODE_ENV=production` keeps Drizzle push OFF (so `payload migrate` applies only the tracked files), and without it the app refuses to start against a non-local database anyway (`src/lib/dbGuard.ts`). A running dev server keeps the connection it started with — changing `.env` does not switch databases until you restart it.

**CI enforces this, fail-closed.** Both deploy jobs run `migrate:verify -- --pre` →
`timeout 600s npm run migrate </dev/null` → `migrate:verify`: `payload migrate` is
interactive and, on a database carrying Payload's dev-push marker (`payload_migrations`
row `dev`, batch `-1`), prompts and exits **0 having applied nothing** — the pre-flight
refuses the marker, the timeout can't hang, and the post-check fails unless every
committed migration is recorded. A brand-new database (no ledger table) passes the
pre-flight, which is how both stages were rebuilt from empty on 2026-09-16. The `verify`
job additionally runs a **schema-drift guard** (`migrate:create --skip-empty` — if you
change a collection and forget to commit a migration, the build fails; run
`npm run migrate:create`, commit the `.ts`/`.json`, push) and a **generated-artifact
drift guard** (regenerates `payload-types.ts` + `admin/importMap.js` and fails on any
diff; run `npm run generate:types` / `generate:importmap` and commit). Details:
`docs/TECHSPEC.md` §10.5.

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
is always at least as new as the code. **A `deploy-production` job now exists**
(added 2026-07-31): it runs `needs: [verify, deploy-staging]`, then waits for a
manual approval on the `production` GitHub Environment, then migrates the
production Neon branch and runs `sst deploy --stage production`. Only the
`production` stage has a custom domain (`bulbau.lu`, wired in `sst.config.ts`
via a stage-conditional `domain` block that *looks up* the Terraform-managed
Route 53 zone); staging stays on its generated `*.cloudfront.net` URL.

**Foundational IaC** (long-lived/stateful resources — the Route 53 hosted zone +
reusable delegation set, the Neon project, the deploy IAM role, and the account
budget/alarm guardrails) lives separately in `infra/terraform/` (Terraform, S3
remote state), deliberately **not** in `sst.config.ts` so a stage teardown can
never destroy DNS or the database. See `infra/terraform/README.md` for the apply
and import runbook. **Applied and live as of 2026-07-31** — the zone is created,
DNS is delegated at EuroDNS, and the Neon project + deploy role are imported
(file = live).

**Where alarms live.** The per-stage Lambda alarms and the `OPS_ALERT` log-metric alarm
are defined in `sst.config.ts`, wired to the real functions by reference (hand-copied
function names in Terraform went stale silently). Terraform keeps the account-level SNS
topic, AWS Budgets, and — enabled via `manage_uptime_monitoring` — the Route 53 health
check on `/api/health` and the CloudFront 5xx alarm in `uptime.tf`, which must live there
because those metrics exist only in us-east-1 (a second SNS topic that needs its own
subscription confirmation). Apply order after an alarm change: deploy SST first, then
`terraform apply`.

> **AWS account:** the app runs alone in the dedicated account `847321857537`
> (`service-calculator-production`); both GitHub Environments' `AWS_DEPLOY_ROLE_ARN`
> point at its Terraform-managed `gh-actions-bulbau-staging-deploy` role (see
> `infra/aws/README.md`). **CI audit gate:** `npm audit --omit=dev --audit-level=high`
> blocks (the code that ships); a full-tree audit runs non-blocking for visibility.

Secrets are never stored in this repo or in GitHub Actions secrets directly
for app-level config — they're SST secrets, scoped per stage (`--stage staging`
or `--stage production`):

```bash
# Required before the first deploy of a stage
npx sst secret set DatabaseUrl   "postgresql://...-pooler..." --stage staging   # POOLED (runtime)
npx sst secret set PayloadSecret "$(openssl rand -base64 32)"  --stage staging
npx sst secret set TotpEncryptionKey "$(openssl rand -base64 32)" --stage staging  # 2FA breaks without it
# Required per stage since 2026-09-16 — the stage's own origin. It is Payload's
# `serverURL`: the origin in password-reset links and the ONLY origin the admin
# session cookie is accepted from (CSRF allowlist), plus canonical/hreflang/OG
# URLs and the authenticator-entry label. Production falls back to
# https://bulbau.lu if unset; staging has no safe fallback (the config logs a warning).
npx sst secret set SiteUrl "https://d20kjuz86nwvyp.cloudfront.net" --stage staging
npx sst secret set SiteUrl "https://bulbau.lu"                    --stage production
# Email (SES) — the verified From address for quote emails, the contact-form
# relay and the admin password reset. Unset ⇒ every send is a no-op (see .env.example).
npx sst secret set EmailSender "info@bulbau.lu" --stage staging
# Cloudflare Turnstile (contact form + email-quote spam check); unset ⇒ no-op.
npx sst secret set TurnstileSecretKey "<secret key>" --stage staging
npx sst secret set TurnstileSiteKey   "<site key>"   --stage staging   # NEXT_PUBLIC_* ⇒ inlined at build, so redeploy
# Recommended before launch (unset ⇒ in-memory rate-limit fallback that under-counts across Lambda instances):
npx sst secret set UpstashRedisRestUrl   "https://xxx.upstash.io" --stage staging
npx sst secret set UpstashRedisRestToken "your-upstash-token"     --stage staging
# Launch only:
# npx sst secret set AllowIndexing "true" --stage production
```

**CMS auto-translation (EN → FR/DE) needs NO secret.** It uses **AWS Translate**,
which authenticates via the Lambda **execution role** — `sst.config.ts` grants the
Web function `translate:TranslateText` and sets `TRANSLATE_ENABLED='true'` on every
deployed stage automatically, so translation is on out of the box on staging/
production (no key to set/rotate). Locally it's a **no-op** unless you set
`TRANSLATE_ENABLED=true` *and* provide AWS credentials allowed to call
`translate:TranslateText` (the S3Mock creds don't count) — otherwise FR/DE fall
back to the EN source. See `docs/PROGRESS.md` → "Phase 5 part 1" for the full
design.

**Content edits reach the edge in seconds (on-demand CloudFront invalidation).**
When the admin publishes, the revalidate hook refreshes the ISR origin **and**
invalidates the CloudFront cache (`src/lib/cdn/invalidate.ts`) — OpenNext does not
purge CloudFront on its own. `sst.config.ts` writes the distribution ID to an SSM
parameter (`/bulbau-lu/<stage>/web-cdn-distribution-id`) and grants the Web function
`ssm:GetParameter` + `cloudfront:CreateInvalidation` — **no secret to set**; it is
automatic on every deployed stage. Locally / in CI it's a **no-op** (the
`CDN_DISTRIBUTION_ID_PARAM` env var is unset, so the time-based `revalidate`
window handles freshness and no AWS access is needed). Full detail:
`docs/PROGRESS.md` → "On-demand CloudFront invalidation".

**No web analytics, and no cookie-consent banner — by design.** The site sets a
single strictly-functional cookie (the visitor's language preference) and no
tracking cookies, so it is exempt from GDPR/ePrivacy consent and ships with no
banner. Visitor analytics were evaluated and deliberately left out of scope: they
serve the site owner (traffic/source insight), not any technical or SEO
requirement, and add a subscription or an always-on service for no launch-critical
benefit. If a site owner later wants stats, add a cookieless tool (self-hosted
Umami, or a client-owned Plausible account) as a small dedicated slice.

The staging **`deploy-staging`** job also passes the (already-existing)
`STAGING_DATABASE_URL_UNPOOLED` secret to the `sst deploy` build step, so the
public pages are statically pre-rendered with real CMS content at deploy time
(not empty until the first ISR revalidation).

GitHub **Environment** secrets are also needed, set in the repo settings (not
via SST). On the **`staging`** Environment:

- `AWS_DEPLOY_ROLE_ARN` — the OIDC deploy role (short-lived assumed role, not a
  stored access key); see `docs/TECHSPEC.md` §10 for the trust policy.
- `STAGING_DATABASE_URL_UNPOOLED` — the **direct** Neon URL used by the CI
  migrate step (see "Database migrations" above).

On the **`production`** Environment (added 2026-07-31; also configure a
**Required reviewers** protection rule here — that is what pauses `deploy-production`
for manual approval):

- `AWS_DEPLOY_ROLE_ARN` — the **same** deploy role ARN as staging (single-app
  account; the role's trust policy allows both the `staging` and `production`
  Environments).
- `PRODUCTION_DATABASE_URL_UNPOOLED` — the **direct** Neon URL of the production
  branch, used by the production migrate step.

Production uses the same secrets with `--stage production` (`DatabaseUrl` is the
production branch's **pooled** URL). Leave `AllowIndexing` unset until the launch flip.

## Project structure

See `docs/TECHSPEC.md` §4 for the full layout and reasoning. Quick pointers:

- `src/app/[locale]/` is the **public site** (Phase 2): the localized root
  layout (`<html lang>`), the pages, and `globals.css` (the prototype's design
  system, ported). i18n lives in `src/i18n/` (routing/request/navigation +
  `messages/{en,fr,de}.json`); `src/proxy.ts` composes next-intl's routing with
  the TOTP admin gate; data access is `src/lib/content.ts`.
- `src/app/(payload)/` is Payload's admin UI + REST/GraphQL (`/admin`, `/api`) —
  its `admin/importMap.js` is generated and must not be hand-edited. `/admin`
  is **not** localized.
- `src/app/(frontend)/` is now just the bare `/ → /<locale>` redirect (the
  repurposed Phase 0 placeholder — the real site is under `[locale]/`).
- `prototype/` is the static, client-approved design reference (zero
  backend logic) — the source the `[locale]/globals.css` design system came from.
- `infra/aws/` holds the one-time IAM bootstrap for GitHub Actions OIDC —
  see its own README. Everything else AWS-related lives in `sst.config.ts`
  at the repo root (not `infra/` — the SST CLI requires this).
- `docs/PROGRESS.md` is the rolling build/debug log and current handoff
  state — read this first if you're picking the project back up.
