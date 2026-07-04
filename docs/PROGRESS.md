# Progress log — bulbau.lu

> Rolling history of what's been built, what broke, what was learned, and what's next. `docs/TECHSPEC.md` is the plan; `docs/FUNCTIONALITY.md` is the target behavior; this document is the record of how far implementation actually is and how it got there. Read this first when picking the project back up, especially in a fresh session with no prior context.

---

## Current state (2026-07-04)

**Phase 0 is done and signed off.** The app runs locally and is deployed to a real AWS staging stack via GitHub Actions, with working admin login, user create/delete, and media upload/delete through S3. This is a stronger result than Phase 0's original "boots with a placeholder page" bar — Phase 0 turned into the actual Payload-on-Lambda spike TECHSPEC §13 called for, and that spike is now genuinely validated, not just assumed.

Live staging URL: `https://d2mj4ke0wr57lb.cloudfront.net` (no custom domain yet). Repo: `github.com/Filip-Ermenkov/Service-Calculator`, everything on this progress log is committed to `main` and pushed — verify with `git log --oneline` if picking this up fresh.

**What's working, confirmed by manual testing:**
- Local dev (`npm run dev` against Docker Postgres or a Neon branch).
- CI (`verify` job): lint, typecheck, unit/integration tests against an ephemeral Postgres, Playwright e2e, production build.
- CI (`deploy-staging` job): OIDC auth to AWS (no stored keys), `sst deploy --stage staging`, succeeds cleanly.
- Deployed admin panel: login, dashboard nav, user list/create, and — as of the latest deploy — media upload and delete through S3.
- Deployed public homepage.

**Known gap going into Phase 1**: no automated test covers the media upload/delete flow (only manually verified in a browser). Closing this needs either real AWS credentials in the CI `verify` job, or a MinIO/LocalStack service container mirroring the existing ephemeral-Postgres pattern. Recommended as the first thing done in Phase 1, before more upload-dependent fields (hero images, project photos, etc.) get added on top of untested ground.

---

## How Phase 0 actually went

The scaffolding part (Next.js 16.2 + Payload 3.85 + Postgres via Drizzle adapter + SST v4/OpenNext + GitHub Actions CI/CD) went roughly as planned. The Lambda spike did not — getting a real deploy to actually serve traffic correctly took five rounds of "deploy, hit a real bug, fix it, redeploy," each a genuine, non-obvious issue rather than a typo or a misconfiguration:

1. **`pg`/`pino` "Cannot find module" at runtime, despite a clean build.** OpenNext's build tracing treats certain packages as "external" — instead of bundling them inline, it copies the real files into the Lambda package via a symlink step. On Windows, that step either throws `EPERM` outright, or (worse) silently "succeeds" while producing a Windows-native symlink that doesn't survive being packaged for a Linux Lambda runtime. First symptom was a hard `EPERM` crash during local `sst deploy` (fixed by enabling Windows Developer Mode, which grants symlink-creation permission) — but the *deploy that then "succeeded"* shipped a broken package anyway, because the underlying symlink-format mismatch wasn't actually about permissions. **Real fix: never run `sst deploy` from native Windows. Deploys go through CI (Ubuntu) exclusively**, which doesn't have this problem at all.
2. **`sharp` "Cannot find package"**, a different flavor of the same class of issue, plus a second problem layered under it: OpenNext excludes `sharp` from the main bundle by default (it assumes `sharp` is only used by Next's own separate image-optimizer function), and even if forced back in, `sharp` ships architecture-specific binaries that wouldn't match anyway (CI builds on x64, the Lambda is configured for arm64). Since Payload's `sharp` integration is optional as of 3.x and the Media collection doesn't use any sharp-dependent feature (no `imageSizes`/resize options), it was removed from `payload.config.ts` rather than fought. Revisit if/when Media actually needs resizing — options then are matching CI/Lambda architecture, or a prebuilt arm64 Sharp Lambda Layer.
3. **Media upload failing with `ENOENT ... mkdir 'media'`.** Payload's `upload: true` shorthand defaults to local-disk storage, which cannot work on Lambda (read-only filesystem outside `/tmp`). SST provisioning an S3 bucket and `link`-ing it to the Next.js component only wires IAM permissions — it doesn't tell Payload to use it. Fixed by adding `@payloadcms/storage-s3` with `clientUploads: true` (uploads go browser → S3 directly via a presigned URL, deliberately chosen over the server-proxied variant since routing file bytes through the Lambda would hit its payload-size limits on any normal-sized photo — a near-term certainty, not a hypothetical).
4. **`getFromImportMap: PayloadComponent not found`**, twice, for two different reasons (once earlier in Phase 0 when a Media field was simplified, once when the S3 plugin was added) — `admin/importMap.js` is generated, not static, and goes stale silently whenever the admin UI's component set changes. No build error, just a broken admin page at runtime and, in CI, a Playwright timeout waiting for a login field that never rendered correctly. **Standing rule now: run `npm run generate:importmap` after touching any collection, field, or plugin that contributes admin UI**, and never hand-edit that file.
5. **`cloudfront:CreateInvalidation` AccessDenied** on the GitHub Actions deploy role, despite a broad region-scoped Allow statement (`aws:RequestedRegion: eu-central-1`) intended to cover exactly this kind of thing. CloudFront (like IAM and Route 53) is a global service whose control-plane calls don't satisfy a regional condition — a gap the policy's own design notes had flagged as a security consideration (for the explicit-Deny backstop) without connecting it to the fact that it would *also* block legitimate global-service calls SST itself needs. Fixed with a dedicated, unconditioned `cloudfront:*` statement. Worth remembering if a custom domain gets added later (Route 53 + ACM): expect the identical gap, same fix pattern.

None of this invalidates the Phase A architecture — every fix was either a build/packaging detail (#1, #2) or a missing piece of glue that any Payload-on-Lambda deployment would need regardless of tooling (#3, #4, #5). The spike's actual question — does Payload run correctly on Lambda — is answered yes.

---

## Decisions made along the way (also reflected in TECHSPEC.md itself)

- **Repo structure**: single app at repo root (`src/`, `package.json`, `sst.config.ts` all at top level), not a monorepo/workspace split. One deployable unit doesn't need `apps/`/`packages/` — that pattern solves a different problem (multiple apps sharing code). `infra/aws/` was added for the one standalone piece of AWS bootstrap that has to exist before SST/CI can even run (the OIDC trust relationship) — deliberately not folded into `sst.config.ts`'s Pulumi-managed resource graph, since it's the thing that makes that graph reachable in the first place.
- **`frontend/` → `prototype/` rename**: the old top-level `frontend/` folder (holding only the static design-reference prototype) collided in name with the real `src/app/(frontend)/` route group. Renamed, zero references anywhere needed updating (verified via grep before renaming).
- **GitHub Actions ↔ AWS**: OIDC federation (short-lived assumed role), not stored access keys — Filip's explicit preference going in, also the current documented best practice from both AWS's and GitHub's own security docs. Trust policy is scoped to the exact repo *and* GitHub Environment (`environment: staging`), which changes the shape of the OIDC subject claim GitHub issues — using a plain branch-ref condition instead would have been wrong for a workflow that sets `environment:`.
- **IAM permission policy for the deploy role**: broad-but-region-scoped Allow, backstopped by an explicit Deny on the highest-risk IAM/org/billing actions, rather than a hand-enumerated least-privilege policy. This mirrors SST's own documented guidance (hand-enumerating exact actions per component is called out, in SST's own docs, as tedious and error-prone) and its recommended path: start reasonably scoped, then run IAM Access Analyzer against real CloudTrail activity to generate an actually-precise policy once there's usage history to analyze. **That tightening pass is a tracked follow-up, not done yet** — don't reuse this exact policy for a `production` role without doing it first.
- **Cost model**: re-verified against `eu-central-1` pricing at sign-off (see `docs/TECHSPEC.md` §9). Lambda's perpetual free tier is confirmed still current. Total is realistically €3–8/month at this traffic level, not a single precise figure — false precision isn't worth claiming here.

---

## Environment quirks worth knowing (specific to this Cowork/Claude working setup, not the app itself)

- The Linux sandbox's mounted view of the Windows-side repo folder has intermittent caching problems: `git status`/`git diff` run via the sandbox's bash sometimes show files as modified/truncated when they are not — confirmed this happened at least once purely from stale cache, not real changes (cross-checked `git show HEAD:<path>` against the Windows-native file read and they matched exactly). **When bash's view of a file looks suspicious, trust `Read`/`Edit`/`Write` (Windows-native) over bash, and cross-verify with `git show HEAD:<path>` rather than trusting `git status`/`git diff` at face value.**
- Similarly, ad hoc JSON/file validity checks run through that same bash session have come back with false failures (e.g. `python3 -c "json.load(...)"` reporting an "unterminated string" for a file that `Read` shows is complete and well-formed) — same root cause, same fix.
- `npm install`/`sst install`/large builds can exceed a single sandbox command's time limit; retrying converges (npm's cache and partial progress persist across calls even though the sandbox itself resets between some turns).

---

## Immediate next steps

1. **Add test coverage for the media upload/delete flow** (flagged above as the one real gap in Phase 0's otherwise-complete state) — decide MinIO/LocalStack vs. real-credentials-in-CI, then implement.
2. **IAM Access Analyzer pass** on the staging deploy role once it's accumulated some real CloudTrail history, per the follow-up noted in `infra/aws/README.md`.
3. **Start Phase 1** (`docs/TECHSPEC.md` §12): define the remaining Payload collections (`Services`, `Projects`, `CareerListings`, `CompanyInfo`, `LegalInfo`, `Translations`), and build the TOTP 2FA login step (Payload doesn't ship 2FA natively — custom hook/endpoint using `otplib`, per §6.6). Per the project's standing workflow: research current best practices for whichever of these is tackled first before writing code, implement, provide a full manual+automated test guide in conversation, get sign-off, then update the docs again.

Provide the client's real Legal Notice details (legal form, RCS Luxembourg number, VAT number, registered address) whenever available — not urgent yet (it only gates Phase 6), but it's an external dependency worth surfacing early rather than discovering the wait late.
