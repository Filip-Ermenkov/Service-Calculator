# Progress — bulbau.lu

What is actually true right now, and what is left. `FUNCTIONALITY.md` is the
what, `TECHSPEC.md` the how, `README.md` the commands.

History lives in git: every slice has a commit message and a PR description
explaining why it was done that way. This file does not repeat them.

---

## Where it stands — 2026-10-31

Every planned feature is built and deployed. Nothing left before launch is
development work.

| | |
|---|---|
| **Production** | `https://bulbau.lu` — live, **indexing off** (`robots.txt` disallows everything) |
| **Staging** | `https://d20kjuz86nwvyp.cloudfront.net` |
| **Deploys** | push to `main` → `verify` → staging → *manual approval* → production |
| **Content** | Legal Notice and Privacy Policy **published** with the client's real details (BULBAU MULTISERVICE, S.A.S, RCS B303936, VAT LU37807402). 1 service, a placeholder (see 3). **0 projects, 0 careers, 0 media.** |
| **Client access** | `office@bulbau.lu` has an admin account with 2FA enrolled |

The AWS facts below were read from the live account on 2026-10-23
(`aws sso login --profile sc-new` first).

---

## What is left

Ordered so the things with external waiting periods start first.

### 1. SES production access — done (granted 2026-10-29)
Out of the sandbox in eu-central-1: 50,000 messages a day, 14 a second, and the
account is healthy. Production sends from `info@bulbau.lu` (the `EmailSender`
secret). **Proven end to end on 2026-10-30**: a quote emailed from the live site
to an address that is not an SES identity arrived with SPF, DKIM and DMARC all
`PASS`. The sandbox-only `f.ermenkov@gmail.com` identity has been removed, so
the account can no longer send as that address. The SES reputation alarms (step
4) now have mail to measure.

### 2. Lambda concurrency — done, 1000 (2026-10-23)
The account limit in eu-central-1 is **1000** (AWS approved the request on
2026-10-23; it had already been raised from the default 10 to 400 on its own).
The `web-lambda-throttles` alarm watches the ceiling.

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

### 4. Monitoring — proven; the SES alarms are waiting for mail
**Proven 2026-10-23** for the twelve alarms that existed (five per SST stage in
eu-central-1, the uptime and CloudFront alarms in us-east-1): all `OK`, none in
`INSUFFICIENT_DATA`, actions enabled. Each SNS topic has one confirmed email
subscription. One alarm per region was forced into `ALARM` with
`aws cloudwatch set-alarm-state`. SNS delivered both notifications (0 failures),
and both alarms returned to `OK` within a minute. Every alarm here also notifies
on recovery, so one incident sends two emails.

GuardDuty findings go to their own topic, `bulbau-lu-security-findings`. That
path was proven on 2026-10-23 with a sample finding: the rule matched and
invoked once, and SNS delivered one email, with no failures anywhere.

The CloudFront 5xx alarm had already fired for real on 2026-10-17, and it was
the only signal that did: the Payload copy-locale bug (see "Known, accepted")
returned 500s that Lambda counted as zero errors and the app never logged as
`OPS_ALERT`.

The SES reputation alarms (`infra/terraform/ses-reputation.tf`: bounce ≥ 2%,
complaint ≥ 0.05%, below AWS's 5% / 0.1% review points) were **applied on
2026-10-23**: the plan was exactly 2 to add, and a follow-up plan shows no
changes. Both sit in `INSUFFICIENT_DATA` because the account has sent no mail in
weeks. That is deliberate (missing data reads as "watching nothing", never as
green), not a fault. They notify the same eu-central-1 topic whose delivery was
proven above. **Settled 2026-10-30:** SES publishes the rates only around sends
(two data points in three days, each at a send), so `INSUFFICIENT_DATA` stays
silent; emailing it would send a message after every quiet hour. After the first
real sends both alarms went to `OK`, which proves they watch the live metric.

### 5. Backup restore rehearsal — done 2026-10-23
Production was branched at a point an hour back without being touched itself.
The branch was ready in 3 s. Every table matched production except the one write
made after that point (an admin login), which is the proof it really was the past.
The branch was then deleted. The runbook and the measured numbers are in
`infra/terraform/README.md` → "Restoring the production database". Putting a
restore live (in place, or by switching the secrets) needs production, so it is
documented but not rehearsed.

**The point-in-time window is only 6 hours** (the Free plan's maximum), so a
**nightly `pg_dump` to S3, kept 35 days**, covers the rest. It runs as
`.github/workflows/db-backup.yml` into `infra/terraform/db-backups.tf`, outside
Neon, and its role can add dumps but never read or delete them. **Set up and
proven 2026-10-24:**
- the first run produced a 320 KB dump (encrypted at rest)
- the dump restored into a throw-away PostgreSQL 18 in about a second, with
  `pg_restore --exit-on-error`
- `scripts/db-fingerprint.sql` on the restored copy is **identical** to
  production's, read-only: all 34 tables (rows and content digest), the
  migration ledger, and the latest edits

Repeat that restore check every few months (`infra/terraform/README.md` →
"Nightly database backups").

### 6. Data processing agreements — confirm before launch
The published Privacy Policy says each processor "acts only on our instructions
under a data processing agreement". `TECHSPEC.md` §7A says these must be
reviewed and accepted, not assumed, so confirm each one before the site is
findable:
- **AWS** (hosting, SES, Translate, DynamoDB): AWS's GDPR DPA is part of its
  Service Terms and applies automatically.
- **Neon** (the database): check its DPA covers this account's plan.
- **Cloudflare** (Turnstile): check its DPA is part of this account's terms.
- **Google Workspace** (the `office@` mailbox): review it in the Admin console →
  Account → Legal and compliance.

This is for whoever holds each account (the developer or the client), not code.

### 7. Launch flip — last, in this order
1. content in, reviewed
2. `npx sst secret set AllowIndexing "true" --stage production` (the Lighthouse
   SEO gate becomes hard at the same moment)
3. Google Search Console: add `bulbau.lu` as a domain property and submit
   `https://bulbau.lu/sitemap.xml`, so Google finds the site in days rather than
   weeks. Verification is a TXT record at the root, and
   `infra/terraform/workspace-mail.tf` owns the whole root TXT set: a value
   added by hand in Route 53 is replaced by the next `terraform apply`. If Search Console does
   not accept the existing Workspace verification, add its value through
   Terraform (a variable beside `google_site_verification`).
4. HSTS `preload` (`HSTS_PRELOAD` in `src/lib/security/headers.ts`) — deliberately
   last, because preload is painful to reverse

### 8. Housekeeping
- rotate the staging Neon password (it sits commented out in the local `.env`)
  and the Neon API key
- the repo is **public** — a commercial client site with its infra topology in
  the open. Private would lose CodeQL on the free tier; it is a decision, not an
  oversight
- DMARC is `p=none`; move to `quarantine` once reports have been arriving
- the Neon URLs use `sslmode=require`. `pg` v9 will give that libpq semantics,
  which skip certificate verification. Switch the `DatabaseUrl` SST secrets and
  the `*_DATABASE_URL_UNPOOLED` GitHub secrets to `sslmode=verify-full` before
  `pg` reaches v9; that also silences the warning `pg` prints on every cold
  start
- the GitHub Actions deploy role still has a broad, region-scoped Allow
  (`DeploymentsScopedToRegion`). Replace it with a least-privilege policy that
  IAM Access Analyzer generates from CloudTrail (`infra/aws/README.md`).
  Policy generation needs a **trail**, and the account had none until
  `security-baseline.tf`. Let it record a few weeks of deploys (both stages,
  one custom-domain change) first; this is post-launch work
- **DNSSEC**: signing has been live since 2026-10-23 18:37 UTC. **On or after 2026-10-25
  at 19:00 UTC**, add the DS record (`terraform output dnssec_ds_record`) at
  EuroDNS. The order matters; see `infra/terraform/README.md` → "DNS hardening"

### Recurring
- `public/.well-known/security.txt` expires on 2027-10-01.
  `tests/int/discoveryFiles.int.spec.ts` starts failing 30 days before that, so
  renewing it is a routine one-line PR: set `Expires` about 11 months ahead.

### Known, accepted, not blocking
- **Every RSC prefetch 307-redirects** and loses its `_rsc` cache-buster, so
  prefetching is effectively off and each costs two Lambda invocations. Known
  upstream Next.js behaviour with i18n middleware rewrites (vercel/next.js
  #91844, #55415). Not a correctness bug.
- **"Copy to locale" crashes on every global** (Company Info, Legal Info). This
  is a Payload bug, not ours; it was reproduced locally on 2026-10-23.
  `@payloadcms/ui`'s `copyDataFromLocale` reads `payload.globals[slug].config`,
  but `payload.globals` is `{ config: [...] }`, so the lookup is always
  `undefined`: the admin gets an error page and nothing is copied. The client
  hit it four times on 2026-10-17. The same wrong lookup in `@payloadcms/next`
  (`fetchLatestVersion`) makes the admin's version-history view for globals
  ignore draft/published status. Collections (services, projects, careers) are
  unaffected, and the button cannot be hidden on a global (`disableCopyToLocale`
  exists only for collections). Still present in Payload 3.92.1; the fixes are
  open upstream (payloadcms/payload#16334, #17072). **Deliberately not patched
  here.** The workaround is the intended workflow: write in English and let
  FR/DE be generated, as the note in `FUNCTIONALITY.md` §6 tells the client. After each Payload upgrade, check
  `node_modules/@payloadcms/ui/dist/utilities/copyDataFromLocale.js`: once it no
  longer reads `globals[globalSlug].config`, delete this entry and the note in
  `FUNCTIONALITY.md` §6.

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
