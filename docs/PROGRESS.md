# Progress — bulbau.lu

What is actually true right now, and what is left. `FUNCTIONALITY.md` is the
what, `TECHSPEC.md` the how, `README.md` the commands.

History lives in git: every slice has a commit message and a PR description
explaining why it was done that way. This file does not repeat them.

---

## Where it stands — 2026-10-23

Every planned feature is built and deployed. Nothing left before launch is
development work.

| | |
|---|---|
| **Production** | `https://bulbau.lu` — live, **indexing off** (`robots.txt` disallows everything) |
| **Staging** | `https://d20kjuz86nwvyp.cloudfront.net` |
| **Deploys** | push to `main` → `verify` → staging → *manual approval* → production |
| **Content** | Legal Notice and Privacy Policy **published** with the client's real details (BULBAU MULTISERVICE, S.A.S, RCS B303936, VAT LU37807402). 1 service, a placeholder (see 3). **0 projects, 0 careers, 0 media.** |
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
Projects, careers, photos, and the real services. Each service needs its
pricing parameters for the calculator. Media is JPEG/PNG/WebP, 4 MB max.

Fixes to what is already live, all in the admin, none needing a deploy:
- the Privacy Policy still shows a literal `[12]` in section 4 ("we keep it
  for [12] months"), in EN, FR and DE. 12 months is confirmed; remove the
  brackets in EN. Saving EN re-translates FR and DE, replacing any hand edits
  there, so check both afterwards.
- the one published service, "Montge" (card title "montage 2", no photos), is
  test content. Replace it with the real services.
- the About text says "BULBAU Multiservices S.A.S." and the Legal Notice says
  "BULBAU MULTISERVICE". One of them is wrong.

Decided by the client, October 2026 — recorded in `FUNCTIONALITY.md` §2.5, §3.1
and §3.5, not open:
- no *autorisation d'établissement* number is shown: the client provided none,
  so there is no field for one
- CVs are kept for 12 months, stated on the Careers page and in the Privacy
  Policy
- the Home-page claims are `200+` projects, `15+` years of experience and `100%`
  certified & insured; the design's `Since 2015` is gone. They stay hard-coded
  in `src/i18n/messages/*.json` on purpose, so a claim cannot change without a
  developer.

### 4. Monitoring proof
Confirm the alarms exist, are not stuck in `INSUFFICIENT_DATA`, and that the
SNS topic reaches a real inbox. An alarm nobody receives is not monitoring.
That is five per SST stage (eu-central-1), the two uptime/CloudFront alarms
(us-east-1), and the two SES reputation alarms. Also confirm the us-east-1 SNS
subscription (CloudFront metrics only exist there).

The SES reputation alarms (`infra/terraform/ses-reputation.tf`: bounce ≥ 2%,
complaint ≥ 0.05%, below AWS's 5% / 0.1% review points) are merged but **not
applied**: set `manage_ses_reputation_alarms = true` and `terraform apply`
(expect 2 to add). They treat missing data as `INSUFFICIENT_DATA` on purpose,
so that state means "watching nothing", not a fault in the alarm. Then read how
often SES publishes the metric and decide whether `INSUFFICIENT_DATA` should
email too. Both steps are in `infra/terraform/README.md` → "Turning the SES
reputation alarms on". They back up the answer to AWS's question in step 1 on
how bounces and complaints are handled.

### 5. Backup restore rehearsal — done 2026-10-23
Production was branched at a point an hour back without being touched itself.
The branch was ready in 3 s. Every table matched production except the one write
made after that point (an admin login), which is the proof it really was the past.
The branch was then deleted. The runbook and the measured numbers are in
`infra/terraform/README.md` → "Restoring the production database". Putting a
restore live (in place, or by switching the secrets) needs production, so it is
documented but not rehearsed.

**The restore window is 6 hours**, the Free plan's maximum. Damage noticed the next
morning cannot be undone. To decide: Neon Launch (up to 7 days), or a scheduled
`pg_dump` to S3.

### 6. Launch flip — last, in this order
1. content in, reviewed
2. `npx sst secret set AllowIndexing "true" --stage production` (the Lighthouse
   SEO gate becomes hard at the same moment)
3. HSTS `preload` (`HSTS_PRELOAD` in `src/lib/security/headers.ts`) — deliberately
   last, because preload is painful to reverse

### 7. Housekeeping
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
