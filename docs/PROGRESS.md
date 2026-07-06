# Progress log — bulbau.lu

> Rolling history of what's been built, what broke, what was learned, and what's next. `docs/TECHSPEC.md` is the plan; `docs/FUNCTIONALITY.md` is the target behavior; this document is the record of how far implementation actually is and how it got there. Read this first when picking the project back up, especially in a fresh session with no prior context.

---

## Current state (2026-07-06)

**Phase 0 is done and signed off** (repo scaffolding, local + deployed-to-Lambda staging, admin login, user/media CRUD through S3, with automated media upload/delete coverage). **Phase 1 is now partially done: the mandatory TOTP two-factor-authentication slice is built** and pending a manual commit by Filip (see "Environment quirks" — commits are never made from the sandbox). The remaining Phase 1 work — the content-model collections — is **not** started yet.

Live staging URL: `https://d2mj4ke0wr57lb.cloudfront.net` (no custom domain yet). Repo: `github.com/Filip-Ermenkov/Service-Calculator`. **The 2FA slice below is committed on top of Phase 0; verify `git log --oneline` and `git status` before trusting this section** — this project's sandbox has had real git/filesystem flakiness (see "Environment quirks").

**What's working (2FA slice), confirmed by automated + manual testing:**
- Mandatory TOTP 2FA on the admin panel: first login forces enrollment at `/admin/totp-setup` (QR + manual secret), every later login on a new session requires a 6-digit code at `/admin/totp-verify`. Password (Payload's own) is the first factor; a signed, httpOnly "step-up" cookie is the second.
- The real security boundary is `requireTotpVerified` on every protected collection's `access` (Users, Media writes) — bypassing the admin UI via REST/GraphQL still can't read/write without a valid step-up cookie. The `proxy.ts` route gate and the admin views/redirects are UX/defense-in-depth on top of that, not the boundary.
- `npm run test:int` green (adds `tests/int/totp.int.spec.ts` and `tests/int/proxy.int.spec.ts`).
- `npm run test:e2e`: 5 of 6 confirmed green by Filip including a manual browser check that a password-only session is redirected off `/admin/collections/users` to `/admin/totp-verify`. The 6th test's flakiness (a TOTP replay-window race, see below) has been fixed; **the full 6/6 run should be re-confirmed by Filip before/at commit time.**

**What is NOT done yet (so a fresh session doesn't assume otherwise):**
- The content-model collections (`Services`, `Projects`, `CareerListings`, `CompanyInfo`, `LegalInfo`, `Translations`) — the rest of Phase 1 (`docs/TECHSPEC.md` §5, §12).
- Everything in Phases 2–7 (public site wired to CMS, calculator/formula engine, PDF quotes, DeepL translation pipeline, contact form + spam protection, hardening pass).
- **Docs not yet reconciled beyond this file:** `docs/TECHSPEC.md` (§12 roadmap + status headers) and `docs/FUNCTIONALITY.md` (Phase-0 status note) still describe Phase 1 as unstarted. They should be updated to reflect that 2FA shipped — that reconciliation was deliberately scoped out of the commit that adds this slice and is a tracked next step.

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
- `npm run test:e2e`: Filip confirmed 5/6 green plus the manual redirect check; the 6th (replay flake) is fixed and should be re-run to confirm 6/6 before relying on it. `npm run devsafe` (clean `.next` + restart) is required after any `proxy.ts` change — Next never hot-reloads the proxy file.

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

1. **Re-confirm the full 6/6 e2e run**, then commit this slice (Filip; the sandbox can't). Delete the untracked `smoke-test-tmp.mjs` while committing.
2. **Reconcile the other docs to reality**: `docs/TECHSPEC.md` §12 roadmap + status headers, and `docs/FUNCTIONALITY.md`'s status note, to record that Phase 1's 2FA shipped. (Only `docs/PROGRESS.md` was updated with this slice.)
3. **Continue Phase 1**: define the remaining Payload collections (`Services`, `Projects`, `CareerListings`, `CompanyInfo`, `LegalInfo`, `Translations`) per `TECHSPEC.md` §5, with the standing workflow (research current best practices first, implement, full manual+automated test guide in-conversation, sign-off, then update docs).
4. **IAM Access Analyzer pass** on the staging deploy role once it has real CloudTrail history (carried over from Phase 0; still not done).
5. Provide the client's real Legal Notice details (legal form, RCS Luxembourg number, VAT number, registered address) whenever available — gates Phase 6 production sign-off (`TECHSPEC.md` §6.9), an external dependency worth surfacing early.
