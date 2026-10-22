# Progress — bulbau.lu

What is actually true right now, and what is left. `FUNCTIONALITY.md` is the
what, `TECHSPEC.md` the how, `README.md` the commands.

History lives in git: every slice has a commit message and a PR description
explaining why it was done that way. This file does not repeat them.

---

## Where it stands — 2026-10-22

Every planned feature is built and deployed. Nothing left before launch is
development work.

| | |
|---|---|
| **Production** | `https://bulbau.lu` — live, **indexing off** (`robots.txt` disallows everything) |
| **Staging** | `https://d20kjuz86nwvyp.cloudfront.net` |
| **Deploys** | push to `main` → `verify` → staging → *manual approval* → production |
| **Content** | Legal Notice **published** with the client's real details (BULBAU MULTISERVICE, S.A.S, RCS B303936, VAT LU37807402). 1 service. **0 projects, 0 careers, 0 media.** |
| **Client access** | `office@bulbau.lu` has an admin account with 2FA enrolled |

**Not verified in this pass** (AWS SSO expired): SES production access, the
Lambda concurrency quota, and whether the CloudWatch alarms have ever fired.
Run `aws sso login --profile sc-new` first.

---

## What is left

Ordered so the things with external waiting periods start first.

### 1. SES production access — client-independent, start now
SES is in sandbox: mail only reaches verified identities, so a visitor's quote
email goes nowhere. The review is about sending practices, not site content, so
this does **not** wait on the client. ~24h turnaround. Console → SES → Account
dashboard → Request production access (eu-central-1, transactional).

### 2. Lambda concurrency 10 → 1000 — client-independent, start now
The account is still on the AWS default of 10 concurrent executions. Under any
real traffic the web function throttles and visitors see errors. Service Quotas
→ AWS Lambda → *Concurrent executions* → request 1000. The
`web-lambda-throttles` alarm already watches for this.

### 3. Client content
Projects, careers, photos, and the remaining services. Each service needs its
pricing parameters for the calculator. Media is JPEG/PNG/WebP, 4 MB max.

Still outstanding from the client:
- the ***autorisation d'établissement*** number — Luxembourg generally requires
  it on commercial communications for regulated trades, and electrical work is
  one. **There is no field for it**, so if it is required that is a schema
  change plus a migration.
- the Privacy Policy body (a draft exists; it needs review against the now-known
  legal entity)
- a **CV retention period**. The Careers page currently promises to keep
  applications "on file" with no stated limit and no privacy policy behind it,
  which is a GDPR storage-limitation problem. Replacement copy is drafted and
  waiting on a number (12 months was proposed).

### 4. Home-page claims — needs a decision, not code
`Since 2015`, `250+ projects completed`, `10+ years`, `100% certified & insured`
are hard-coded in `src/i18n/messages/*.json` and are not admin-editable. Either
the client can substantiate each one, or it goes. A false factual claim on a
commercial site is a consumer-law exposure.

### 5. Monitoring proof
Confirm the five alarms exist, are not stuck in `INSUFFICIENT_DATA`, and that
the SNS topic reaches a real inbox. An alarm nobody receives is not monitoring.
Also confirm the us-east-1 SNS subscription (CloudFront metrics only exist
there).

### 6. Backup restore rehearsal
A Neon PITR restore has never been tested. Untested backups are not backups.

### 7. Launch flip — last, in this order
1. content in, reviewed
2. `npx sst secret set AllowIndexing "true" --stage production` (the Lighthouse
   SEO gate becomes hard at the same moment)
3. HSTS `preload` (`HSTS_PRELOAD` in `src/lib/security/headers.ts`) — deliberately
   last, because preload is painful to reverse

### 8. Housekeeping
- `delete_branch_on_merge` is off
- the `protect-main` ruleset has a `Repository admin` bypass, so admins can push
  straight to `main`
- rotate the staging Neon password (it sits commented out in the local `.env`)
  and the Neon API key
- the repo is **public** — a commercial client site with its infra topology in
  the open. Private would lose CodeQL on the free tier; it is a decision, not an
  oversight
- DMARC is `p=none`; move to `quarantine` once reports have been arriving

### Known, accepted, not blocking
- **`braces` GHSA-vfj7-8cjw-p6xm** has no patched release. It is build-time only
  and absent from the deployed artifact; the evidence is written into
  `scripts/audit-production-deps.mjs`, which fails if the exception goes stale
  or passes its review date (2026-12-31).
- **Every RSC prefetch 307-redirects** and loses its `_rsc` cache-buster, so
  prefetching is effectively off and each costs two Lambda invocations. Known
  upstream Next.js behaviour with i18n middleware rewrites (vercel/next.js
  #91844, #55415). Not a correctness bug.
- **`next/font/google` runs at build time**, so every deploy depends on Google's
  font CDN being reachable — it has already failed one deploy. `next/font/local`
  would remove that, and a Google request from every visitor's first paint.

---

## Rules this project learned the hard way

These are not general advice. Each one cost real time here.

**Verify against the installed source and the live system** — never against
docs, `npm audit`'s "fix available", or a previous session's conclusion. Nearly
every serious bug found here was found by re-reading code or running the
product after someone had concluded things were fine.

**A passing CI step must prove its post-condition.** The migrate step "passed"
for six weeks while applying nothing. The Lighthouse artifact upload "passed"
while uploading nothing.

**A gate that fires wrongly is worse than no gate.** Two false positives in the
image smoke check, and one in the schema-drift guard, each blocked a production
deploy. Prove *every branch* of a guard — including the failure branches —
before shipping it, not just the happy path.

**Distinguish "the check failed" from "the thing is broken."** The drift guard
reported "your schema changed" when the check had merely timed out. The
difference is what makes a message actionable.

**Prove a regression test fails without its fix.** Both directions.

**Make the URL the key.** A media file's public path is `/` + its S3 key, so the
edge needs no rewrite, dev needs one, and there is one string to reason about.

**On Lambda, a counter that is not shared is not a limit.** Every instance has
its own memory; every cold start resets it.

**A header the app sets only reaches responses the app sends.** Anything
CloudFront answers from S3 gets no Next.js headers — the policy has to be
projected to the edge from the same source.

**Every Payload access operation must be set explicitly** — `read`, `create`,
`update`, `delete`, `unlock`, `readVersions`. The fallback is
`Boolean(req.user)`, i.e. any password-only session. `?draft=true` restricts
nothing on its own.

**A comment in `.env` is not a guard; a process that refuses to start is**
(`src/lib/dbGuard.ts`).

**Pin the framework's internals you depend on.** OpenNext calls Next.js
internals directly. When Next changed `fetchInternalImage`'s arity, every
optimized image 500'd — and when the fix moved sharp to a version selected by a
different npm flag, every image silently served *unoptimized* at full size.
`tests/int/imageOptimizerBuild.int.spec.ts` and
`scripts/smoke-image-optimizer.mjs` exist to catch both.

**Nothing in CI can see the OpenNext runtime.** Lighthouse, Playwright and the
integration tests all run against `next start` — Next's own optimizer, its own
server. The deployed stages run OpenNext's, in separate Lambdas. Only a
post-deploy check against the real stage covers that gap.

**Prefer an AWS-native, execution-role-authenticated service over a third-party
free tier** when it does the same job. This project lost DeepL's, MinIO's and
LocalStack's free tiers mid-build.

**Deploy through CI (Ubuntu), never `sst deploy` from Windows** — OpenNext's
symlinks do not survive Windows packaging and the deploy "succeeds" with files
missing.
