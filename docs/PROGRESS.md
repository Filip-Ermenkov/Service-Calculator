# Progress log — bulbau.lu

> Rolling history of what's been built, what broke, what was learned, and what's next. `docs/TECHSPEC.md` is the plan; `docs/FUNCTIONALITY.md` is the target behavior; this document is the record of how far implementation actually is and how it got there. Read this first when picking the project back up, especially in a fresh session with no prior context.

---

## Current state (2026-07-08)

**Phase 0 and Phase 1 are complete, committed, and now live on staging.** A fresh session picking this up starts at **Phase 2** (public site wired to the CMS).

- **Phase 0** (signed off 2026-07-04): repo scaffolding — Next.js 16.2 + Payload 3.85 on Lambda via OpenNext/SST, Neon Postgres, admin auth, S3 media CRUD, CI.
- **Phase 1** (2026-07-06): mandatory TOTP 2FA (`23a8b7c`) + the full content model — Services/Projects/CareerListings collections and CompanyInfo/LegalInfo globals, EN/FR/DE localization, draft/publish, public-read access control, and the LegalInfo publish gate (`aec6c25`, `41f615f`). All CRUD-usable through the default Payload admin.
- **Phase 1.5** — DB migrations workflow + deploy-secret wiring (`59a9e20`, `60b8a21`; 2026-07-07): the operational layer that made Phase 1 deployable (its own section below).

**Staging cutover complete and verified (2026-07-08)**, confirmed by Filip against this session's end-to-end guide: the staging Neon branch was baselined once (`migrate:fresh`), CI ran `payload migrate` (a no-op on the baseline) then `sst deploy`, and **staging now serves the real Phase 1, not the Phase 0 build**. Verified live on the staging URL — admin panel loads (proving `TOTP_ENCRYPTION_KEY` is wired), first login forces `/admin/totp-setup`, CRUD works across all collections, anonymous `GET /api/services` hides drafts, and a `migrate:create` → push round-trip applied exactly one new migration through CI. **Schema evolution is now a solved, repeatable operation.**

Live staging URL: `https://d2mj4ke0wr57lb.cloudfront.net` (no custom domain yet). Repo: `github.com/Filip-Ermenkov/Service-Calculator`. **Before trusting this section, verify `git log --oneline` and `git status`** — this project's sandbox has had real git/filesystem flakiness (see "Environment quirks").

> **✅ Blocker fully resolved and verified live (2026-07-08):** the "no migrations step on deploy" blocker is closed end-to-end. `src/payload.config.ts` sets `migrationDir` + explicit `push` (dev/CI push on; deployed stages push OFF, migrations only); the initial migration is committed at `src/migrations/`; `.github/workflows/ci.yml`'s `deploy-staging` runs `npm run migrate` (direct/unpooled Neon URL, `NODE_ENV=production`, fail-fast if the URL secret is missing) before `sst deploy`; and the staging Neon branch has been baselined and is now tracking migrations. Local dev and CI tests are unaffected (they push on boot).

**What is NOT done yet (so a fresh session doesn't assume otherwise):**
- **The public site is still the Phase 0 placeholder** — visitors don't yet see CMS content. Wiring the public pages (Home / Projects / Service / About / Careers) to real content is **Phase 2, the immediate next slice**. An administrator can already log in securely (on staging) and manage all content; the public just doesn't render it yet.
- **Everything in Phases 2–7**: public site + URL-based i18n + SEO + Legal/Privacy pages (Phase 2); the visual **Calculator Field/Formula Builder** + live evaluator (Phase 3 — Phase 1 defines only the `calculatorFields`/`formula` *data*, not the UI); PDF quotes (Phase 4); the DeepL translation pipeline + the `Translations` management surface (Phase 5 — deliberately deferred, see `TECHSPEC.md` §5: with native localization, translations live inside each field's per-locale values, so the shadow collection is inseparable from the DeepL hooks and admin view); contact form + spam protection (Phase 6); hardening / Well-Architected pass (Phase 7).
- Carried follow-ups: IAM Access Analyzer pass on the deploy role; an optional CI schema-drift guard; and the client's real legal details (a hard gate on Phase 6). See "Immediate next steps".

---

## Phase 1, part 1 — TOTP 2FA (built 2026-07-06)

Payload has no native 2FA, so this is custom code layered on top of Payload's own email/password auth, per `docs/TECHSPEC.md` §6.6. `docs/FUNCTIONALITY.md` §5.1 treats 2FA as **mandatory, not optional**.

### What was built (files in this slice)

- `src/lib/totp/` — the crypto/OTP toolkit, all Node-runtime:
  - `keys.ts` — one root secret (`TOTP_ENCRYPTION_KEY`, separate from `PAYLOAD_SECRET` for key separation) → two HKDF-derived subkeys (one for AES-256-GCM encryption, one for HMAC signing).
  - `crypto.ts` — AES-256-GCM encrypt/decrypt of the TOTP secret at rest (`iv:authTag:ciphertext`, base64).
  - `otp.ts` — `otplib` wrappers (SHA-1/6-digit/30s defaults, matching mainstream authenticator apps); `epochTolerance: 30` (±1 window) and `afterTimeStep` replay protection.
  - `stepUpToken.ts` — plain HMAC-SHA256 "second-factor-verified" token (`uid`, `exp`), 2h TTL matching Payload's session; `timingSafeEqual` compare.
  - `requestHelpers.ts` — parse/verify the step-up cookie from headers or Payload's cookie map; build set/clear `Set-Cookie` values.
  - `rateLimit.ts` — Upstash Redis sliding-window limiter (5/5min) when `UPSTASH_REDIS_REST_URL/TOKEN` are set; an in-memory fallback for local/CI (same "real service in prod, local stand-in for dev/CI" pattern as S3Mock; not safe multi-instance, warns if it ever activates in prod).
  - `qr.ts` — QR data-URL for the enrollment screen.
- `src/collections/Users.endpoints.ts` — custom endpoints under `/api/users/totp/*`: `setup` (mint secret + QR; re-enroll requires current step-up), `enable` (confirm a code, flip `totpEnabled`, set step-up cookie), `verify` (per-login second factor, sets step-up cookie, user+IP rate-limited), `disable` (requires step-up **and** password re-check), `status`.
- `src/access/requireTotpVerified.ts` — access wrapper: denies unless there's a `req.user`, `totpEnabled`, **and** a valid step-up cookie for that user id; then delegates to the wrapped access fn. **This is the security boundary.**
- `src/proxy.ts` — Next.js 16 Node-runtime request interceptor (the `proxy.ts` convention that replaced `middleware.ts` in Next 16) gating `/admin/:path*`: a password-only session hitting a protected admin route is redirected to `/admin/totp-verify`. UX/defense-in-depth; verifies the `payload-token` JWT itself (see the key-derivation bug below).
- `src/components/admin/` — `TotpSetupView`/`TotpSetupForm`, `TotpVerifyView`/`TotpVerifyForm` (new Payload admin root views at `/admin/totp-setup` and `/admin/totp-verify`), and `BeforeDashboardTotpGate` (a `beforeDashboard` redirect gate). Registered in `payload.config.ts` and `src/app/(payload)/admin/importMap.js` (regenerated, not hand-edited).
- `src/collections/Users.ts` — hidden, non-API-readable `totpSecret`/`totpEnabled`/`totpLastTimeStep` fields; the five endpoints; `requireTotpVerified`-wrapped access; Payload's own `maxLoginAttempts: 5` / `lockTime: 10m` for the password step.
- `src/collections/Media.ts` — writes (`create`/`update`/`delete`) now 2FA-gated; public `read` unchanged (the public site fetches media directly).
- Env/CI/docs: `TOTP_ENCRYPTION_KEY` + Upstash vars added to `.env.example` and CI (`ci.yml`); README gained a 2FA section; `payload.config.ts` wires the views/components; `payload-types.ts` regenerated.
- Tests: `tests/int/totp.int.spec.ts` (crypto round-trip, replay protection, rate-limit fallback, access wrapper, field-hiding), `tests/int/proxy.int.spec.ts` (the proxy's gate logic in isolation), `tests/e2e/totp.e2e.spec.ts` (full enrollment + new-session flows); `tests/helpers/seedUser.ts` gained `seedUnenrolledTestUser`/`seedEnrolledTestUser`; `tests/helpers/login.ts` completes the TOTP step.

### Two real bugs surfaced during testing (both worth a fresh session knowing)

1. **Proxy verified the session JWT against the wrong key — the headline bug.** `src/proxy.ts` verified the `payload-token` with the **raw** `PAYLOAD_SECRET`. Payload does **not** sign with the raw value: on init it derives `crypto.createHash('sha256').update(config.secret).digest('hex').slice(0, 32)` (see `node_modules/payload/dist/index.js`, `BasePayload` init) and signs/verifies with `TextEncoder().encode(...)` of **that**. So every real token failed with `signature verification failed`; `verifiedPayloadUserId` returned `undefined`; the proxy fell through to `NextResponse.next()` and never redirected — the symptom was a password-only session landing on `/admin/collections/users` and seeing an empty "Nothing found" list (the access wrapper correctly denied the data; only the redirect UX was missing). The integration test masked it because it hand-signed its test tokens with the raw secret too — test and buggy proxy agreed with each other while both disagreed with reality. **Fix:** `payloadJwtKey()` in `proxy.ts` reproduces Payload's exact derivation and is **exported and reused by the int test**, so the two can't drift again. **Lesson:** the one piece of custom code re-deriving Payload's own behavior is exactly where reality diverged — from a confidently-worded but unverified comment ("does not hash or transform"). Verify such assumptions against the installed source, and never let a test re-implement the very thing it's meant to check.
   - **Diagnostic red herring worth not repeating:** this was first mis-attributed to Turbopack "not running" the proxy, because `.next/.../middleware-manifest.json` was empty. That file is empty *by design* for a **Node-runtime** proxy — those register in `functions-config-manifest.json`, not `middleware-manifest.json`. A brief switch of `dev` to `--webpack` was a wrong turn (it only added slow-compile timeouts) and was reverted; `dev`/`devsafe` stay on Turbopack. What actually pinned it was temporary `console.warn` instrumentation in the proxy: the dev-server log showed `jwtVerify FAILED: signature verification failed`, which is unambiguous. When a Node-runtime proxy "doesn't fire," instrument it and read the server console rather than reasoning about manifests.
2. **TOTP replay-window flake in the e2e suite (a test bug, not a code bug).** The "new session" test reused the account the enrollment test had *just* enrolled. When its login code fell in the same 30-second TOTP window whose time-step enrollment had already consumed, otplib's replay protection (correctly) rejected it — a ~50–70%-of-runs timeout depending on where the window boundary fell. The 2FA logic is right; the test was unrealistic (real "new session" logins happen long after enrollment). **Fix:** `seedEnrolledTestUser` seeds a dedicated, already-enrolled account with an untouched time-step; the new-session test uses that, which also removes a hidden test-1→test-2 ordering dependency.

### Verification
- `npm run test:int`: green (both new int files; `proxy.int.spec.ts` now signs with the derived key via the shared `payloadJwtKey`).
- `npm run test:e2e`: **now green in CI.** The `deploy-staging` job that shipped Phase 1 `needs: verify`, which runs the full e2e suite — so all 6 passed there (the replay-flake fix included), plus Filip's earlier manual redirect check. `npm run devsafe` (clean `.next` + restart) is required after any `proxy.ts` change — Next never hot-reloads the proxy file.

---

## Phase 1, part 2 — content model (built 2026-07-06)

Completes Phase 1: all the collections and globals the rest of the app builds on, wired for EN/FR/DE localization and draft/publish, usable through the default Payload admin.

### What was built (files in this slice)

- `src/collections/Services.ts` — localized `title`/`description`/card fields, `heroImage`/`cardImage` uploads, `orderable: true` (drag order = Home-page card order, via Payload's fractional-index ordering), `versions.drafts`, and the calculator *data*: a `calculatorFields` array (localized `label`/option labels only; `fieldKey`/`type`/`unitPrice`/`sign`/`required` shared across locales) + a `formula` JSON field. The visual builder over these is Phase 3 (`TECHSPEC.md` §6.4); a service with zero calculator fields is a valid published state (§7).
- `src/collections/Projects.ts` — localized `title`/`description`, `photo`, `completionDate` (`defaultSort: '-completionDate'` → newest first, §3.2), `service` relationship, `versions.drafts`. The §7 "retain the service label even after the service is deleted" requirement is a Phase 2 concern (a denormalized snapshot, added when the Projects-page filter is built) — noted in-file, not built here.
- `src/collections/CareerListings.ts` — localized `title`/`description`, `photo`, `orderable`, and an explicit `status` select (`active`/`archived`) rather than drafts: §5.5 models this as a visibility toggle with Archive/Restore, not a draft→publish authoring flow.
- `src/globals/CompanyInfo.ts` — `email`/`phone`/`facebookUrl`/`instagramUrl` + localized `aboutUsContent`; public `read`, 2FA-gated `update`; no drafts (changes are immediate per §5.6).
- `src/globals/LegalInfo.ts` — legal identity fields + localized `privacyPolicyContent`, `versions.drafts`, and the **§6.9 publish gate**: the five identity fields are `required: true` (Payload blocks publishing them empty while still allowing incomplete *drafts*), **plus** an authoritative `beforeValidate` hook that throws one clear, aggregated error if `_status === 'published'` with any of them blank. The pure checker `findMissingLegalFields` is exported and unit-tested.
- `src/access/publicRead.ts` — `readPublishedOrVerified` / `publicReadWhen(where)`: read access that returns `true` for a *fully 2FA-verified* admin (sees drafts/archived) and a query constraint (`_status: published`, or `status: active` for careers) for everyone else — anonymous public **and** password-only sessions. Deliberately mirrors the three checks in `requireTotpVerified` (the write boundary) so a password-only session can never see drafts through the read path either.
- `src/payload.config.ts` — registers the three collections + two globals; localization expanded from `['en']` to `en`/`fr`/`de` (`defaultLocale: 'en'`, `fallback: true`) **now**, so localized fields have their final shape and FR/DE going live in Phase 5 needs no schema migration.
- `src/payload-types.ts` — regenerated (now includes `services`/`projects`/`career-listings`/`company-info`/`legal-info`).
- `tests/int/content.int.spec.ts` — Local-API integration coverage (see Verification).
- `tests/int/rest.int.spec.ts` — **HTTP-boundary** coverage: invokes the real Payload REST route handler (`REST_GET(config)`) with hand-built `Request`s + cookies, asserting the actual `/api/services` and `/api/career-listings` responses hide drafts/archived from anonymous **and** password-only sessions while a verified-admin cookie sees drafts. Added after a browser `GET /api/services` (from a logged-in, TOTP-verified admin) appeared to leak drafts — it was the correct "verified admin sees everything" path, but the confusion was legitimate and the public HTTP path deserved its own explicit test. Also asserts the **localization fallback** at the serve layer: `?locale=de` returns the EN title for an untranslated field (`localization.fallback: true`), while `?locale=de&fallback-locale=none` returns it empty — the counterpart to the admin editor deliberately showing raw (empty) per-locale values, which surfaced as a second point of confusion during manual testing.

### Decisions worth a fresh session knowing

- **Native localization for all three locales from day one**, not just EN. Enabling FR/DE later would be a data-structure change on every localized field (Payload warns existing data is lost when toggling `localized`), so paying that cost now — while the tables are empty — is the cheap, correct time. FR/DE simply fall back to EN until Phase 5 populates them.
- **`orderable: true` over a manual `order` field.** Payload's built-in fractional-index ordering is the current best practice (verified against the 3.x docs at build time) and gives drag-and-drop in the admin for free; a hand-rolled integer `order` was the older pattern.
- **Careers uses `status`, Services/Projects use drafts.** Different requirements: services/projects are authored-then-published content (drafts + preview fit); a job listing is just shown or hidden (a select fits, and needs no version history).
- **`Translations` deferred to Phase 5** (see "What is NOT done yet"). This is a deliberate scoping call, recorded in `TECHSPEC.md` §5.
- **Publish gate = `required: true` + a hook**, not one or the other: `required` gives clean per-field admin errors and the drafts-bypass-required behaviour we want; the hook guarantees the gate (with one clear message) even if a `required` flag is ever removed, which is what §6.9 literally asks for ("a validation hook prevents…").

### The migrations gap (the headline finding)

This slice is the first to add tables, and doing so surfaced that **the deploy path has no schema-migration step** — it is not a bug in this slice; it's a pre-existing gap that only a schema-changing slice could reveal. Local dev/CI are unaffected (Payload pushes on boot when `NODE_ENV !== 'production'`); only the Lambda staging deploy was blocked. **→ Resolved in Phase 1.5 (below), and the staging cutover has since run — staging is live on Phase 1.**

### Verification (what was actually run, and where)

Sandbox constraints (documented under "Environment quirks") mean the normal toolchain (`npm run generate:types`, `vitest`, `next build`) can't run against the Windows-mounted `node_modules` directly — its native binaries (esbuild/SWC) are Windows-only, and Turbopack has no sandbox bindings. So verification was done on a **sandbox-local copy** of `src`/`tests` with a fresh Linux resolution path:

- **Typecheck — clean (`tsc --noEmit`, exit 0)** across the new collections, globals, access helper, config, and `content.int.spec.ts`, **after** regenerating `payload-types.ts`. (Before regenerating, the only errors were the stale generated types not knowing the new slugs — expected; they all cleared on regeneration.)
- **Runtime integration — 16/16 assertions pass** against a **real Payload boot on a real Postgres** (Postgres 18 via `embedded-postgres`; Payload's TypeScript loaded through Node 22's native `--experimental-strip-types` with a small `@/`-path resolve hook, so no esbuild was needed — Payload/`pg`/Drizzle are pure JS). Covered: EN/FR per-locale storage + DE→EN fallback; the draft/published read gate (public blocked, verified admin allowed, public visible after publish); careers active vs archived; public `CompanyInfo`; and the full `LegalInfo` publish gate (blocked incomplete → allowed as draft → publishes when complete → readable publicly). The committed `tests/int/content.int.spec.ts` mirrors these exactly and will run in CI's real vitest+Postgres job.
- **HTTP boundary — 7/7 assertions pass** against the **real REST route handler** (`REST_GET(config)`, the same one Next serves at `/api/*`), invoked in-process with constructed `Request`s and a real `payload-token` JWT from `payload.login`: anonymous `GET /api/services` and `/api/career-listings` return only published/active; a verified-admin cookie sees drafts; a password-only cookie (stolen password, no TOTP step-up) is treated exactly like the public. `tsc` on `tests/int/rest.int.spec.ts` is clean. This closes the one coverage gap surfaced this session — the tests now cover the public read gate at both the access-rule layer (Local API) **and** the real HTTP layer.
- **`payload-types.ts` was regenerated via Payload's own `generateTypes(config)`** (deterministic from config, identical to `npm run generate:types`) and copied into the repo. `importMap.js` is **unchanged** and needs no regeneration — this slice adds no custom admin components (all fields are built-in types).
- **CI caught a real environment bug the in-sandbox harness structurally could not (now fixed).** On the first CI run, `rest.int.spec.ts` failed with `TypeError: payload must be an instance of Uint8Array` from `payload.login()`. Root cause: the int suite runs under Vitest's **jsdom** environment (`vitest.config.mts`), and Vitest's jsdom setup replaces the global `Uint8Array` with jsdom's own copy, which breaks `jose`'s `instanceof Uint8Array` check during JWT signing (a documented jose+vitest-jsdom issue — panva/jose#671, vitest#5183). Only `rest.int.spec.ts` hits it because it's the only int test that signs a JWT (`payload.login`). **Fix:** a `/** @vitest-environment node */` docblock at the top of `rest.int.spec.ts` — these are server-side HTTP-API tests with no DOM, so `node` is both correct and the documented remedy. **Lesson for future sessions:** the sandbox verification harness loads TS via Node's `--experimental-strip-types` and therefore runs in a **pure Node** environment — it cannot reproduce Vitest-jsdom-specific behavior (global overrides, `instanceof` across realms). For anything sensitive to the test environment, CI is the authority; treat sandbox green as necessary, not sufficient.
- **Not run in-sandbox, validated by CI on push:** `next build` (needs the Linux Next/SWC binary) and the Playwright e2e suite (no new public pages yet — Phase 2). Filip should let CI confirm both, and can re-run `npm run test:int` locally to see `content.int.spec.ts` green in the real harness.

**Environment quirk hit again:** mid-slice, the Linux side of the mount served a **truncated** copy of `payload.config.ts` (125 lines) while the authoritative Windows-side file (via the `Read`/`Edit` tools, and git) was complete and correct (151 lines). This is the same Windows↔Linux sync flakiness noted below — the fix was to reconstruct the sandbox test copy from authoritative content (heredoc) and trust `Read`/`Edit` for the deliverable, exactly as "Environment quirks" prescribes. The committed files are correct; the truncation was only ever the sandbox's stale view.

---

## Phase 1.5 — DB migrations workflow + deploy-secret wiring (built 2026-07-07)

The content-model slice surfaced a blocker (no migrations step on deploy) and, while fixing it, a second latent gap (2FA runtime secrets never wired into `sst.config.ts`). Both block the *same* "next staging deploy," so they're handled together here. This slice adds no product features — it's the operational layer that lets the already-built Phase 1 actually and safely reach a deployed stage.

### What was built (files in this slice)

- `src/payload.config.ts` — `postgresAdapter` now sets `migrationDir: path.resolve(dirname, 'migrations')` and an **explicit** `push: process.env.NODE_ENV !== 'production'` (Payload's own default, made explicit so the dev-push/prod-migrate boundary is documented and can't drift). `prodMigrations` is deliberately **not** set — running migrations at Lambda init would fire on every cold start and let concurrent cold starts race on DDL; on serverless, migrations belong in CI, once per deploy.
- `src/migrations/20260707_153821_initial.{ts,json}` + `src/migrations/index.ts` — the initial full-schema migration (Payload-generated), covering the entire current schema: **33 tables, 15 enums**, with `up` and `down`. Includes Users/Media/Services/Projects/CareerListings/CompanyInfo/LegalInfo, all `*_locales` tables, the `_v` version tables for the drafts-enabled collections (services/projects/legal_info — and correctly *none* for careers-by-status or company_info), the nested calculator-field/option arrays, and Payload's system tables (`payload_migrations`, `payload_locked_documents(+_rels)`, `payload_preferences(+_rels)`, `payload_kv`).
- `package.json` — `migrate`, `migrate:create`, `migrate:status`, `migrate:fresh` scripts (thin `payload` CLI wrappers, matching the existing `payload` script's `cross-env` style).
- `sst.config.ts` — three new `sst.Secret`s injected into the `Web` Lambda's env: `TotpEncryptionKey` (**required** — `src/lib/totp/keys.ts` throws without it, so a missing key would break the admin panel on first load; making it a no-default secret means `sst deploy` fails loudly rather than shipping broken 2FA), and `UpstashRedisRestUrl`/`UpstashRedisRestToken` (**optional**, default `''` ⇒ the rate limiter's in-memory fallback; set real values before production, where multiple instances make in-memory unsafe).
- `.github/workflows/ci.yml` — a `Run database migrations (staging)` step in `deploy-staging`, before `sst deploy`: `npm run migrate` with `NODE_ENV=production` (push off), `DATABASE_URL` = the **direct/unpooled** Neon URL from a new `STAGING_DATABASE_URL_UNPOOLED` GitHub Environment secret, and a throwaway non-empty `PAYLOAD_SECRET` (migrate does DDL, not token signing — deliberately not duplicating the real secret into GitHub). Fail-closed: a bad migration stops the job and nothing deploys. The future `deploy-production` TODO now notes it needs the same migrate-first step.
- Docs: `docs/TECHSPEC.md` (new §10.5, §13 risk marked resolved + the new secrets-gap risk, §10.2/§12 touch-ups), `README.md` (a "Database migrations" section + the new deploy secrets), `.env.example` (the pooled-vs-direct note).

### Decisions worth a fresh session knowing

- **Push in dev/CI, migrate on deployed stages** — Payload's own recommended split, kept (not "push:false everywhere"). CI's `verify` job keeps pushing on boot against its ephemeral Postgres, so the test suite is untouched; only real stages are migrations-only. Having committed migrations present does **not** affect push mode (push ignores the migration files), so `test:int`/`test:e2e` stay green.
- **Migrate in CI, not `prodMigrations`** — the serverless-correct choice (see above), and what Payload's docs recommend for anything that isn't a long-running container.
- **Neon: migrations use the DIRECT (unpooled) URL** — DDL breaks through Neon's PgBouncer pooler (transaction pooling). Runtime stays pooled; only the CI migrate step uses the direct URL. This is the single most likely thing to get wrong, so it's called out in the workflow comment, README, `.env.example`, and TECHSPEC §10.5.
- **`TotpEncryptionKey` required, Upstash optional** — encodes the actual severity: no TOTP key = broken admin (hard-fail the deploy); no Upstash = degraded-but-working rate limiting (tolerated pre-launch).

### Verification (what was actually run, and where)

Validated end-to-end against a **real Postgres** in the sandbox (Postgres 17 via `embedded-postgres`), driving Payload's own migration APIs programmatically:

- **Generate** — `payload.db.createMigration()` against an empty DB produced the initial migration: **33 `CREATE TABLE`, 15 `CREATE TYPE`, with a `down()`**. Table inventory matches the documented design exactly (drafts→`_v`; careers/company_info→none; every localized collection→`_locales`).
- **Apply** — `payload.db.migrate()` applied it cleanly; all 33 tables present; one `payload_migrations` row (`20260707_153821_initial`, batch 1).
- **Idempotency** — a second `migrate()` was a no-op (still one row).
- **Completeness** — a second `createMigration(--skip-empty)` detected **no** changes and wrote no file, proving the committed migration fully captures the config's schema (no drift).
- **Config/adapter** — `postgresAdapter` accepts `{ pool, migrationDir, push }` without error; the full config boots (`getPayload` init) in `NODE_ENV=production`/push-off mode. `package.json` (Read-tool authoritative view) and `ci.yml` (YAML) parse clean.
- **Not run in-sandbox, deferred to CI/Filip's toolchain** (per the standing "sandbox green is necessary, not sufficient; CI is the authority" rule): `tsc --noEmit`, `next build`, the real `payload` CLI (its `tsx`/esbuild loader needs a Linux binary the Windows-mounted `node_modules` doesn't have — see below), and everything that needs Neon/AWS credentials (the staging baseline + first migrated deploy).

**Update (2026-07-08) — now verified live on staging.** Every deferred item above has run: CI's `verify` job is green (`tsc`, `next build`, `test:int`, `test:e2e`); the staging Neon branch was baselined with `migrate:fresh`; and `deploy-staging` ran `payload migrate` (no-op on the baseline) then `sst deploy` successfully. One real bug was caught and fixed along the way — the first `deploy-staging` after committing failed at the migrate step with `ECONNREFUSED ::1:5432`, because `STAGING_DATABASE_URL_UNPOOLED` wasn't set yet, so an empty `DATABASE_URL` made `pg` fall back to localhost. Fixed two ways: setting the secret (the one-time cutover), and adding a fail-fast guard to the CI step (`60b8a21`) so a missing/empty URL now prints a clear, actionable error instead of a cryptic connection refusal. Staging now serves Phase 1, and a follow-up `migrate:create` → push confirmed CI applies exactly one new migration per schema change. **The workflow is operational, not just designed.**

### Sandbox constraints hit (and how they were worked around)

- **The `payload` CLI can't load the TS config in-sandbox** — it uses `tsx`→esbuild, and `@esbuild/linux-x64` isn't in the Windows-mounted `node_modules` (the same "native binaries are Windows-only" quirk from Phase 0). Worked around exactly as the content-model session did: load the config with Node 22's native `--experimental-strip-types` + a small `@/`-alias/extensionless resolve hook, and call `createMigration`/`migrate` on `payload.db` directly. One wrinkle: Payload's generated migration imports `MigrateUpArgs`/`MigrateDownArgs` as *values* (`import { MigrateUpArgs, MigrateDownArgs, sql }`), which `--strip-types` can't elide (only real `tsx`/esbuild does), so the sandbox apply-test patched that one import line in a scratch copy; **the committed file keeps Payload's original import** (correct for CI/Filip's toolchain).
- **`bwrap --unshare-pid --die-with-parent`** — every bash call is its own PID namespace, so **no process survives between calls** (background/`setsid`/`nohup` all die with the call). But the on-disk `pgdata` persists, so the pattern is: warm the cluster (`initdb`) once, then reuse the data dir in later calls (start is ~0.4s, no initdb). Also note `pkill -f postgres` **self-matches** the calling shell (its command line contains "postgres") and kills the call — use `pkill -x postgres` or, since nothing survives a call anyway, don't bother.
- **Stale mount reads** — after editing `package.json` via the Edit tool, the Linux side served a truncated pre-edit copy (2473 bytes, unterminated mid-string), which broke Node's module resolution for any in-sandbox eval. The Read tool (authoritative Windows view) confirmed the file was correct; the adapter-options check was rerun mount-independently (importing `@payloadcms/db-postgres` by absolute path). Same Windows↔Linux flakiness as always — trust Read/Edit/Write.

### What is NOT done (so a fresh session doesn't assume otherwise)

- ~~The one-time staging baseline + first migrated deploy~~ — **done (2026-07-08)**; staging is live on Phase 1 (see the Verification update above).
- **A CI schema-drift guard** (fail the `verify` job if someone changes a collection without generating a migration) — still not done. A good hardening for the "periodic maintenance only" end-state, but deliberately deferred: it's scope beyond this slice and has CI edge cases better added and observed on their own. Carried to "Immediate next steps".

---

## Media upload/delete test coverage — closed (2026-07-04, follow-up to Phase 0)

Phase 0 signed off with one flagged gap: media upload/delete through S3 was only ever manually verified. `tests/int/media.int.spec.ts` now creates a Media doc via the Local API, confirms the object actually lands in S3 via a direct `HeadObjectCommand` (not just Payload's DB row), then deletes it and confirms it's gone — against Adobe's **S3Mock** (Apache-2.0, purpose-built for this), chosen over MinIO/LocalStack after research found both had discontinued their free/CE container images (Oct 2025 / Mar 2026). Writing it surfaced three genuine bugs: a Vitest file-parallelism race against the shared ephemeral Postgres (`fileParallelism: false`), config drift between the test's own S3 client and `payload.config.ts` (share config, don't reimplement), and S3Mock's incomplete CORS support breaking browser `clientUploads` (now `clientUploads: !process.env.S3_ENDPOINT` — off against S3Mock, on for real AWS). Full detail lived in prior revisions of this file; the standing lesson is that "current best practices" must be re-checked at implementation time, not trusted from when a plan was written.

---

## How Phase 0 went (the Lambda spike)

Scaffolding (Next.js 16.2 + Payload 3.85 + Postgres/Drizzle + SST v4/OpenNext + GitHub Actions) went roughly as planned; getting Payload to actually serve on Lambda took five real, non-obvious fixes, none of which invalidated the architecture:
1. OpenNext copies externalized packages (`pg`, `pino`) into the Lambda bundle via symlinks that Windows can't reliably produce as Linux symlinks → **deploys go through CI (Ubuntu) only, never native Windows.**
2. `sharp` is excluded from the main server bundle by OpenNext and ships arch-specific binaries that don't cross-compile (x64 CI → arm64 Lambda) → omitted entirely (nothing in Media uses it; it's now also removed from `package.json`, keeping deps honest).
3. Media uploads need an explicit storage adapter (`@payloadcms/storage-s3`) — SST linking a bucket only wires IAM, it doesn't make Payload use it.
4. `admin/importMap.js` is generated, not static — regenerate (`npm run generate:importmap`) after any collection/field/plugin that contributes admin UI; silently stale otherwise.
5. IAM's `aws:RequestedRegion` doesn't scope global services (CloudFront/IAM/Route 53) → CloudFront needed its own unconditioned statement.

---

## Decisions made along the way (also reflected in TECHSPEC.md)

- **Repo structure**: single app at repo root, not a monorepo; `infra/aws/` holds only the one-time OIDC bootstrap that must exist before SST/CI can run.
- **GitHub Actions ↔ AWS**: OIDC federation (short-lived assumed role), scoped to the exact repo **and** the `staging` GitHub Environment.
- **IAM deploy policy**: broad-but-region-scoped Allow + explicit Deny on high-risk actions; **tighten with IAM Access Analyzer before reusing for a `production` role** (still a tracked follow-up).
- **S3Mock over MinIO/LocalStack** for S3 integration testing (license/distribution changes made both non-viable).
- **2FA (this slice)**: mandatory (`FUNCTIONALITY.md` §5.1); Payload password auth + a custom TOTP step-up cookie; `requireTotpVerified` access wrapper is the boundary, `proxy.ts`/views are UX; `TOTP_ENCRYPTION_KEY` is a **separate** secret from `PAYLOAD_SECRET` (key separation); rate limiting via Upstash with an in-memory local/CI fallback; the proxy must reproduce Payload's own JWT key derivation (see the bug above).
- **docker-compose Postgres host port**: committed as `5431` (mapped to the container's `5432`) to avoid clashing with a system Postgres; `.env.example` line 2 now matches. If this ever feels wrong as a shared default, the idiomatic alternative is a gitignored `docker-compose.override.yml` for personal ports — noted, not done.

---

## Environment quirks worth knowing (specific to this Cowork/Claude sandbox, not the app)

- The Linux sandbox's view of the Windows-mounted repo has intermittent caching problems: `git status`/`git diff`/`cat` sometimes show stale or truncated content. **Trust the Windows-native `Read`/`Edit`/`Write` tools over bash; cross-verify with `git show HEAD:<path>`.** When bash's copy of a file looks stale, rewrite it via a heredoc (`cat > path <<'EOF' ... EOF`) from content confirmed by `Read`.
- **Do not run `git add`/`commit`/`push` from the sandbox** — a stale `.git/index.lock` once could not be removed (`rm` returns `Operation not permitted` on the Windows mount). Filip commits via his own tooling (GitHub Desktop). The same permission quirk means the sandbox **cannot delete files** on the mount — e.g. `smoke-test-tmp.mjs` (a harmless leftover, untracked) had to be left for Filip to delete manually.
- `npm install`/`sst install`/large builds can exceed a single sandbox command's time limit; retrying converges.
- **Turbopack cannot run in this sandbox** — only WebAssembly SWC bindings are available, and Turbopack requires native bindings (`Turbopack is not supported on this platform`). For any in-sandbox `next build`/`next dev` reproduction, use `--webpack`. Filip's real machine (Windows) uses Turbopack, which is the Next 16 default for both `dev` and `build`; keep that distinction in mind when reproducing bundler-adjacent behavior (it's why the Turbopack red herring above was hard to rule out from the sandbox alone).

---

## Immediate next steps

Phase 0, Phase 1, and the migrations workflow (Phase 1.5) are done and **live on staging** (cutover completed 2026-07-08). What's next, in priority order:

1. **Begin Phase 2 — public site wired to the CMS.** The immediate slice and the biggest remaining chunk of user-visible product. Per the standing workflow: research current best practices first, implement, write a full manual + automated E2E test guide in-conversation, sign off, then update docs. Scope (`TECHSPEC.md` §6.1–6.2, §6.9–6.11; `FUNCTIONALITY.md` §2–3): render Home / Projects / Service / About / Careers from real CMS content via ISR (replacing the `prototype/` static reference); URL-based i18n (`next-intl`, `/en|/fr|/de`, EN complete, FR/DE falling back to EN until Phase 5); Legal Notice & Privacy Policy pages (may stay in Draft until real legal details arrive); cookie-free analytics; SEO basics; and a keyboard/screen-reader pass on every public page. Two items Phase 1 left as data-only belong here: the Projects "retain the service label after the service is deleted" snapshot (§7) and the sitewide default estimate disclaimer. Phase 2's first schema change is also the migrations workflow's first real use in anger — `migrate:create`, commit, and confirm CI applies exactly one migration.

2. **IAM Access Analyzer pass** on the staging deploy role, now that it has real CloudTrail history (carried from Phase 0; staging has run several real deploys). Replace the broad region-scoped Allow in `infra/aws/github-actions-deploy-policy.json` with the generated least-privilege policy before this pattern is reused for a `production` role. The CI migrate step assumes no AWS role (it talks to Neon directly), so it adds no IAM surface.

3. **(Hardening, optional) CI schema-drift guard** — add a step to the `verify` job that runs `migrate:create --skip-empty` against the ephemeral Postgres and fails if it writes a file, catching a future collection change that forgot its migration. Worth adding before the "periodic-maintenance-only" end-state.

4. **A `deploy-production` job — deliberately not yet.** It belongs with Phase 7 (hardening), once there's a custom domain and the app is feature-complete. When added it mirrors `deploy-staging` (migrate-then-deploy, production DIRECT URL) behind a GitHub Environment manual-approval gate, and is **migrations-only, never push**.

5. **Client legal details** (legal form, RCS Luxembourg number, VAT number, registered address) — still outstanding. The `LegalInfo` publish gate (`TECHSPEC.md` §6.9) is built and enforced, so the page **cannot** be published until these are entered; a hard gate on Phase 6 production sign-off.
